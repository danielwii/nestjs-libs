import { Logger } from '@nestjs/common';

import { SysEnv } from '@app/env';
import { f } from '@app/utils/logging';

import os from 'node:os';

import * as _ from 'radash';

import type { INestApplication } from '@nestjs/common';

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

    logger.error(f`(${os.hostname}) uncaughtException: ${err.message ?? err}`, err.stack);
    if (SysEnv.EXIT_ON_ERROR) {
      // Sentry.captureException(err);
      app
        .close()
        .catch((error: Error) => {
          logger.error(f`(${os.hostname}) exit by uncaughtException error: ${error.message}`, error.stack);
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
      logger.warn(
        f`(${os.hostname}) unhandledRejection: AI_NoOutputGeneratedError (likely abort, but promise not properly awaited): ${maybeError?.message ?? 'unknown'}`,
      );
      return;
    }

    logger.error(
      f`(${os.hostname}) unhandledRejection: ${err instanceof Error ? err.message : err} - ${(err as { cause?: unknown })?.cause ?? 'unknown cause'} -`,
      err instanceof Error ? err.stack : undefined,
    );
    if (SysEnv.EXIT_ON_ERROR) {
      // Sentry.captureException(err);
      app
        .close()
        .catch((error: Error) => {
          logger.error(f`(${os.hostname}) exit by unhandledRejection error: ${error.message}`, error.stack);
        })
        .finally(() => {
          logger.error(
            f`(${os.hostname}) exit by unhandledRejection... ${err instanceof Error ? err.message : err}`,
            err instanceof Error ? err.stack : undefined,
          );
          process.exit(2);
        });
    }
  });
  process.on('beforeExit', (reason) => {
    logger[reason ? 'error' : 'log'](f`(${os.hostname}) App will exit cause: ${reason}`);
  });
  process.on('SIGINT', (signals) => {
    logger.log(f`(${os.hostname}) Received SIGINT. ${signals} (${process.pid})`);
    if (process.env.NODE_ENV !== 'production') {
      setTimeout(() => {
        void import('why-is-node-running')
          .then((module) => module.default(logger))
          .finally(() => {
            process.exit(0);
          });
      }, 3000);
    }
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
    app
      .close()
      .catch((error: Error) => {
        logger.error(f`(${os.hostname}) exit by SIGTERM error: ${error.message}`, error.stack);
      })
      .finally(() => {
        process.exit(0);
      });
  });

  return app;
};
