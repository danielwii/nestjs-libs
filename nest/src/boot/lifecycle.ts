import { Logger } from '@nestjs/common';

import { SysEnv } from '@app/env';
import { f } from '@app/utils/logging';

import os from 'node:os';

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
  const logger = new Logger('AppRunner');
  logger.log(f`(${os.hostname}) runApp in (${SysEnv.environment.env}) env`);

  process.on('uncaughtException', (err) => {
    if ((err as unknown) === 'request closed') return;

    // 忽略 graphql-upload-ts 库的已知 bug：文件清理时的 callback 错误
    // 这个错误不影响业务逻辑，只是清理临时文件时的内部错误
    // 注意：不检查堆栈路径，因为 webpack 打包后路径会改变（本地 src/，生产 webpack://）
    if (err instanceof TypeError && err.message === 'callback is not a function') {
      logger.warn(f`(${os.hostname}) Ignored known graphql-upload-ts cleanup error: ${err.message}`);
      return;
    }

    logger.error(f`(${os.hostname}) uncaughtException: ${err.message}`, err.stack);
    if (SysEnv.EXIT_ON_ERROR) {
      // Sentry.captureException(err);
      app
        .close()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          logger.error(f`(${os.hostname}) exit by uncaughtException error: ${message}`, stack);
        })
        .finally(() => {
          logger.error(f`(${os.hostname}) exit by uncaughtException...`);
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
      logger.warn(f`(${os.hostname}) unhandledRejection: AI_NoOutputGeneratedError (likely abort):\n${detail}`);
      return;
    }

    const detail = formatRejectionDetail(err);
    logger.error(f`(${os.hostname}) unhandledRejection:\n${detail}`);
    if (SysEnv.EXIT_ON_ERROR) {
      // Sentry.captureException(err);
      app
        .close()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? error.stack : undefined;
          logger.error(f`(${os.hostname}) exit by unhandledRejection error: ${message}`, stack);
        })
        .finally(() => {
          logger.error(f`(${os.hostname}) exit by unhandledRejection...\n${formatRejectionDetail(err)}`);
          process.exit(2);
        });
    }
  });
  process.on('beforeExit', (reason) => {
    logger[reason ? 'error' : 'log'](f`(${os.hostname}) App will exit cause: ${reason}`);
  });
  let sigintReceived = false;
  process.on('SIGINT', (signals) => {
    if (sigintReceived) return;
    sigintReceived = true;
    logger.log(f`(${os.hostname}) Received SIGINT. ${signals} (${process.pid})`);
    app
      .close()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(f`(${os.hostname}) exit by SIGINT: ${message}`);
      })
      .finally(() => {
        logger.log(f`(${os.hostname}) SIGINT shutdown complete`);
        process.exit(0);
      });
  });
  process.on('SIGHUP', () => {
    logger.warn('Process SIGHUP (可能是终端关闭)，强制退出...');
    process.exit(1);
  });
  process.on('disconnect', () => {
    logger.warn('Process disconnected (可能是终端关闭)，强制退出...');
    process.exit(1);
  });
  process.on('exit', (reason) => {
    logger[reason ? 'error' : 'log'](f`(${os.hostname}) App exit cause: ${reason} (${process.pid})`);
    // sometimes the process will not exit, so we force exit it
    setTimeout(() => process.exit(0), 5e3);
  });
  process.on('SIGTERM', (signals) => {
    logger.log(f`(${os.hostname}) Received SIGTERM. ${signals} (${process.pid})`);
    logger.log(f`(${os.hostname}) Starting graceful shutdown, waiting for in-flight requests...`);

    const server = app.getHttpServer();
    const IN_FLIGHT_TIMEOUT_MS = SysEnv.IN_FLIGHT_TIMEOUT_MS;

    // 停止接收新连接，但保持现有连接
    server.close(() => {
      logger.log(f`(${os.hostname}) HTTP server closed, all connections drained`);
    });

    // 等待进行中的请求完成（最多 30s）
    const waitForConnections = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(f`(${os.hostname}) In-flight timeout (${IN_FLIGHT_TIMEOUT_MS}ms), forcing shutdown`);
        resolve();
      }, IN_FLIGHT_TIMEOUT_MS);

      server.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    waitForConnections
      .then(() => app.close())
      .catch((error: unknown) => {
        // SIGTERM 关闭时连接已断开是预期行为，不是异常
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(f`(${os.hostname}) exit by SIGTERM: ${message}`);
      })
      .finally(() => {
        logger.log(f`(${os.hostname}) Graceful shutdown complete`);
        process.exit(0);
      });
  });

  return app;
};
