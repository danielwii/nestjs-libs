import { SysEnv } from '@app/env';
import { grpcMicroserviceRef, grpcPort, shutdownState } from '@app/nest/boot/shutdown-state';
import { ConnectionManagerService } from '@app/nest/connection/connection-manager.service';
import { getAppLogger } from '@app/utils/app-logger';
import { getErrorMessage } from '@app/utils/error';

import os from 'node:os';

import * as Sentry from '@sentry/nestjs';
import * as _ from 'radash';

import type { INestApplication } from '@nestjs/common';

/** 提取 unhandledRejection 的完整信息（含类型、stack、cause）用于日志 */
function formatRejectionDetail(err: unknown): string {
  const type = err === null ? 'null' : err === undefined ? 'undefined' : typeof err;
  const constructorName =
    err !== null && err !== undefined && typeof err === 'object' ? Object.prototype.toString.call(err) : '-';

  let message: string;
  let stack: string | undefined;
  let cause: unknown;

  if (err instanceof Error) {
    message = err.message;
    stack = err.stack;
    cause = err.cause;
  } else if (typeof err === 'string') {
    message = err;
  } else if (err !== null && err !== undefined && typeof err === 'object') {
    const withMessage = err as { message?: string };
    message = withMessage.message ?? JSON.stringify(err);
    const withStack = err as { stack?: string };
    stack = withStack.stack;
    const withCause = err as { cause?: unknown };
    cause = withCause.cause;
  } else {
    message = String(err);
  }

  const parts: string[] = [`[type=${type}, constructor=${constructorName}]`, `message: ${message}`];
  // DOMException（如 AbortError/TimeoutError）通常无 stack，补充 name/code 便于诊断
  if (typeof err === 'object' && err !== null && constructorName.includes('DOMException')) {
    const dom = err as { name?: string; code?: number };
    if (dom.name) parts.push(`name: ${dom.name}`);
    if (typeof dom.code === 'number') parts.push(`code: ${dom.code}`);
  }
  if (cause !== undefined && cause !== 'unknown cause') {
    let causeStr: string;
    if (cause instanceof Error) {
      causeStr = cause.message;
    } else if (typeof cause === 'object' && cause !== null) {
      causeStr = JSON.stringify(cause);
    } else {
      // 已排除 Error 和 object，此处 cause 为 primitive，String() 安全
      causeStr = String(cause as string | number | boolean | undefined | symbol | bigint);
    }
    parts.push(`cause: ${causeStr}`);
  }
  if (stack) {
    parts.push(`stack:\n${stack}`);
  } else {
    parts.push('stack: (none)');
  }
  return parts.join('\n');
}

export const runApp = <App extends INestApplication>(app: App) => {
  const logger = getAppLogger('boot', 'AppRunner');
  logger.info`(${os.hostname}) runApp in (${SysEnv.environment.env}) env`;

  process.on('uncaughtException', (err) => {
    if ((err as unknown) === 'request closed') return;

    // 忽略 graphql-upload-ts 库的已知 bug：文件清理时的 callback 错误
    // 这个错误不影响业务逻辑，只是清理临时文件时的内部错误
    // 注意：不检查堆栈路径，因为 webpack 打包后路径会改变（本地 src/，生产 webpack://）
    if (err instanceof TypeError && err.message === 'callback is not a function') {
      logger.warning`(${os.hostname}) Ignored known graphql-upload-ts cleanup error: ${err.message}`;
      return;
    }

    logger.error`(${os.hostname}) uncaughtException: ${err}`;
    if (SysEnv.EXIT_ON_ERROR) {
      Sentry.captureException(err);
      app
        .close()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error`(${os.hostname}) exit by uncaughtException error: ${message}`;
        })
        .finally(() => {
          logger.error`(${os.hostname}) exit by uncaughtException...`;
          process.exit(1);
        });
    }
  });
  process.on('unhandledRejection', (err: unknown) => {
    const maybeError = err instanceof Error ? err : undefined;
    const isAiNoOutputError =
      maybeError?.name === 'AI_NoOutputGeneratedError' ||
      (maybeError?.message && /no output generated/i.test(maybeError.message));

    if (isAiNoOutputError) {
      // 设计意图：LLMService 已统一处理 NoOutputError 并检查 signal.aborted
      // 如果走到这里，说明是 unhandledRejection（floating promise 未正确处理）
      // 记录警告但不退出，因为可能是预期的 abort
      const detail = formatRejectionDetail(err);
      logger.warning`(${os.hostname}) unhandledRejection: AI_NoOutputGeneratedError (likely abort):\n${detail}`;
      return;
    }

    const detail = formatRejectionDetail(err);
    logger.error`(${os.hostname}) unhandledRejection:\n${detail}`;
    if (SysEnv.EXIT_ON_ERROR) {
      Sentry.captureException(err);
      app
        .close()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error`(${os.hostname}) exit by unhandledRejection error: ${message}`;
        })
        .finally(() => {
          logger.error`(${os.hostname}) exit by unhandledRejection...\n${formatRejectionDetail(err)}`;
          process.exit(2);
        });
    }
  });
  process.on('beforeExit', (reason) => {
    logger[reason ? 'error' : 'info']`(${os.hostname}) App will exit cause: ${reason}`;
  });
  // 统一的 shutdown 守卫：防止 SIGINT/SIGUSR1/SIGTERM 重复触发 graceful shutdown
  let shuttingDown = false;

  /** 优雅关闭：标记下线 → 排空等待 → 停止接收 + 等待 in-flight → 销毁依赖 → exit */
  const gracefulShutdown = async (signal: string, exitCode: number) => {
    if (shuttingDown) {
      logger.warning`(${os.hostname}) ${signal} ignored, shutdown already in progress (${process.pid})`;
      return;
    }
    shuttingDown = true;
    const shutdownStart = Date.now();
    const elapsed = () => `${Date.now() - shutdownStart}ms`;

    // --- Phase 1: 标记下线 ---
    shutdownState.value = true;
    logger.info`(${os.hostname}) [${signal}] Phase 1: marked as shutting down (${process.pid}) at +${elapsed()}`;

    // --- Phase 2: 排空等待 — 让 K8s/LB 传播端点变更 ---
    // SIGINT（Ctrl+C）跳过 drain delay，本地开发不需要等 LB
    const DRAIN_DELAY_MS = signal === 'SIGINT' ? 0 : SysEnv.DRAIN_DELAY_MS;
    if (DRAIN_DELAY_MS > 0) {
      logger.info`(${os.hostname}) [${signal}] Phase 2: drain delay ${DRAIN_DELAY_MS}ms at +${elapsed()}`;
      await new Promise((r) => setTimeout(r, DRAIN_DELAY_MS));
      logger.info`(${os.hostname}) [${signal}] Phase 2: drain delay complete at +${elapsed()}`;
    } else {
      logger.info`(${os.hostname}) [${signal}] Phase 2: drain delay skipped (${signal}) at +${elapsed()}`;
    }

    // --- Phase 2.5: 通知 SSE/WS 客户端断开 ---
    // 必须在 Phase 3 drain 之前执行，否则 SSE 客户端不知道该断开，HTTP drain 永远超时
    try {
      const connectionManager = app.get(ConnectionManagerService);
      const { sse, ws } = connectionManager.getActiveConnectionCount();
      logger.info`(${os.hostname}) [${signal}] Phase 2.5: notifying clients sse=${sse} ws=${ws} at +${elapsed()}`;
      await connectionManager.notifyAndCloseAll();
      logger.info`(${os.hostname}) [${signal}] Phase 2.5: client notifications complete at +${elapsed()}`;
    } catch (e) {
      logger.warning`(${os.hostname}) [${signal}] Phase 2.5: failed: ${getErrorMessage(e)}`;
    }

    // --- Phase 2.6: gRPC GOAWAY drain (fire-and-forget) ---
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS internals not typed
      const msForDrain = grpcMicroserviceRef as any;
      const grpcServerForDrain = msForDrain?.serverInstance?.grpcClient as
        | { drain?: (port: string, graceTimeMs: number) => void }
        | undefined;
      if (grpcServerForDrain?.drain && grpcPort !== undefined) {
        const grpcUrl = `0.0.0.0:${grpcPort}`;
        const GRPC_DRAIN_MS = SysEnv.GRPC_DRAIN_MS;
        logger.info`(${os.hostname}) [${signal}] Phase 2.6: gRPC drain ${grpcUrl} graceTimeMs=${GRPC_DRAIN_MS} (fire-and-forget) at +${elapsed()}`;
        grpcServerForDrain.drain(grpcUrl, GRPC_DRAIN_MS);
      } else {
        logger.info`(${os.hostname}) [${signal}] Phase 2.6: skip (no grpc server or port)`;
      }
    } catch (e) {
      logger.warning`(${os.hostname}) [${signal}] Phase 2.6: failed: ${getErrorMessage(e)}`;
    }

    // --- Phase 3: 停止接收 + 等待 in-flight ---
    const IN_FLIGHT_TIMEOUT_MS = SysEnv.IN_FLIGHT_TIMEOUT_MS;
    logger.info`(${os.hostname}) [${signal}] Phase 3: stopping servers, timeout=${IN_FLIGHT_TIMEOUT_MS}ms at +${elapsed()}`;

    const httpServer = app.getHttpServer();
    let httpDrained = false;
    let grpcDrained = false;

    httpServer.getConnections?.((err: Error | null, count: number) => {
      if (!err) logger.info`(${os.hostname}) [${signal}] Phase 3: HTTP connections=${count} at +${elapsed()}`;
    });

    // HTTP: 停止接收新连接
    httpServer.close(() => {
      logger.info`(${os.hostname}) [${signal}] Phase 3: HTTP server closed at +${elapsed()}`;
    });

    // gRPC: NestJS NestMicroservice → .serverInstance (ServerGrpc) → .grpcClient (grpc.Server)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 访问 NestJS 内部属性
    const ms = grpcMicroserviceRef as any;
    const grpcServer = ms?.serverInstance?.grpcClient as
      | { tryShutdown?: (cb: () => void) => void; forceShutdown?: () => void }
      | undefined;

    const grpcDrainPromise = new Promise<void>((resolve) => {
      if (grpcServer?.tryShutdown) {
        logger.info`(${os.hostname}) [${signal}] Phase 3: gRPC tryShutdown started at +${elapsed()}`;
        grpcServer.tryShutdown(() => {
          grpcDrained = true;
          logger.info`(${os.hostname}) [${signal}] Phase 3: gRPC tryShutdown complete at +${elapsed()}`;
          resolve();
        });
      } else {
        grpcDrained = true;
        logger.info`(${os.hostname}) [${signal}] Phase 3: no gRPC server, skipping gRPC drain`;
        resolve();
      }
    });

    // HTTP: 等待连接排空
    const httpDrainPromise = new Promise<void>((resolve) => {
      httpServer.on('close', () => {
        httpDrained = true;
        logger.info`(${os.hostname}) [${signal}] Phase 3: HTTP drained at +${elapsed()}`;
        resolve();
      });
    });

    // 总超时 — drain 先完成则清理 timer，避免空转
    let phase3Timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      phase3Timer = setTimeout(() => {
        logger.warning`(${os.hostname}) [${signal}] Phase 3: timeout (${IN_FLIGHT_TIMEOUT_MS}ms), forcing at +${elapsed()} httpDrained=${httpDrained} grpcDrained=${grpcDrained}`;
        if (grpcServer?.forceShutdown) {
          logger.warning`(${os.hostname}) [${signal}] Phase 3: gRPC forceShutdown at +${elapsed()}`;
          grpcServer.forceShutdown();
        }
        resolve();
      }, IN_FLIGHT_TIMEOUT_MS);
    });

    await Promise.race([Promise.all([httpDrainPromise, grpcDrainPromise]), timeoutPromise]);
    clearTimeout(phase3Timer);
    logger.info`(${os.hostname}) [${signal}] Phase 3: servers stopped at +${elapsed()} httpDrained=${httpDrained} grpcDrained=${grpcDrained}`;

    // --- Phase 4: 销毁依赖 ---
    logger.info`(${os.hostname}) [${signal}] Phase 4: app.close() at +${elapsed()}`;
    try {
      await app.close();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warning`(${os.hostname}) [${signal}] Phase 4: app.close() error: ${message} at +${elapsed()}`;
    }

    // --- Phase 5: 退出 ---
    logger.info`(${os.hostname}) [${signal}] Phase 5: exit at +${elapsed()} exitCode=${exitCode}`;
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT', 0).catch((e: unknown) => {
      logger.error`shutdown error: ${e}`;
      process.exit(1);
    });
  });
  // SIGUSR1: memory-watchdog sidecar 触发的优雅重启（exit code 42 区分于 SIGTERM）
  process.on('SIGUSR1', () => {
    gracefulShutdown('SIGUSR1', 42).catch((e: unknown) => {
      logger.error`shutdown error: ${e}`;
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM', 0).catch((e: unknown) => {
      logger.error`shutdown error: ${e}`;
      process.exit(1);
    });
  });

  process.on('SIGHUP', () => {
    logger.warning`Process SIGHUP (可能是终端关闭)，强制退出...`;
    process.exit(1);
  });
  process.on('disconnect', () => {
    logger.warning`Process disconnected (可能是终端关闭)，强制退出...`;
    process.exit(1);
  });
  process.on('exit', (reason) => {
    logger[reason ? 'error' : 'info']`(${os.hostname}) App exit cause: ${reason} (${process.pid})`;
    // sometimes the process will not exit, so we force exit it
    setTimeout(() => process.exit(0), 5e3);
  });

  return app;
};
