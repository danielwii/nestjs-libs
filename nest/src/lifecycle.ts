import { INestApplication, Logger } from '@nestjs/common';
import _ from 'lodash';

import { f } from '@app/utils';
import os from 'node:os';

export const runApp = <App extends INestApplication>(app: App) => {
  process.on('uncaughtException', async (err) => {
    if (_.eq(err, 'request closed')) return;

    Logger.error(f`(${os.hostname}) uncaughtException: ${err.message ?? err}`, err.stack, 'Process');
    // Sentry.captureException(err);
    await app.close();
    Logger.error(`(${os.hostname}) exit by uncaughtException...`, 'Process');
    process.exit(1);
  });
  process.on('unhandledRejection', async (err: Error) => {
    Logger.error(f`(${os.hostname}) unhandledRejection: ${err.message ?? err}`, err.stack, 'process');
    // Sentry.captureException(err);
    await app.close();
    Logger.error(`(${os.hostname}) exit by unhandledRejection...`, 'Process');
    process.exit(1);
  });
  process.on('beforeExit', (reason) => {
    Logger[reason ? 'error' : 'log'](f`(${os.hostname}) App will exit cause: ${reason}`, 'Process');
  });
  process.on('SIGINT', async (signals) => {
    Logger.log(f`(${os.hostname}) Received SIGINT. ${signals} (${process.pid})`, 'Process');
  });
  process.on('exit', (reason) => {
    Logger[reason ? 'error' : 'log'](f`(${os.hostname}) App exit cause: ${reason} (${process.pid})`, 'Process');
    // sometimes the process will not exit, so we force exit it
    setTimeout(() => process.exit(0), 3e3);
  });

  return app;
};
