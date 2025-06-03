import { INestApplication, Logger } from '@nestjs/common';
import _ from 'lodash';

import { SysEnv } from '@app/env';
import { f } from '@app/utils';
import os from 'node:os';

export const runApp = <App extends INestApplication>(app: App) => {
  const logger = new Logger('AppRunner');
  logger.log(f`(${os.hostname}) runApp in (${SysEnv.environment.env}) env`);

  process.on('uncaughtException', async (err) => {
    if (_.eq(err, 'request closed')) return;

    logger.error(f`(${os.hostname}) uncaughtException: ${err.message ?? err}`, err.stack);
    // Sentry.captureException(err);
    try {
      await app.close();
    } catch (error: any) {
      logger.error(`(${os.hostname}) exit by uncaughtException error: ${error.message}`, error.stack);
    } finally {
      logger.error(`(${os.hostname}) exit by uncaughtException...`);
      process.exit(1);
    }
  });
  process.on('unhandledRejection', async (err: Error) => {
    logger.error(
      f`(${os.hostname}) unhandledRejection: ${err.message ?? err} - ${_.get(err, 'cause', 'unknown cause')} -`,
      err.stack,
    );
    // Sentry.captureException(err);
    try {
      await app.close();
    } catch (error: any) {
      logger.error(`(${os.hostname}) exit by unhandledRejection error: ${error.message}`, error.stack);
    } finally {
      logger.error(`(${os.hostname}) exit by unhandledRejection... ${err.message}`, err.stack);
      process.exit(2);
    }
  });
  process.on('beforeExit', (reason) => {
    logger[reason ? 'error' : 'log'](f`(${os.hostname}) App will exit cause: ${reason}`);
  });
  process.on('SIGINT', async (signals) => {
    logger.log(f`(${os.hostname}) Received SIGINT. ${signals} (${process.pid})`);
  });
  process.on('exit', (reason) => {
    logger[reason ? 'error' : 'log'](f`(${os.hostname}) App exit cause: ${reason} (${process.pid})`);
    // sometimes the process will not exit, so we force exit it
    setTimeout(() => process.exit(0), 5e3);
  });
  process.on('SIGTERM', async (signals) => {
    logger.log(f`(${os.hostname}) Received SIGTERM. ${signals} (${process.pid})`);
    setTimeout(() => process.exit(0), 5e3);
  });

  return app;
};
