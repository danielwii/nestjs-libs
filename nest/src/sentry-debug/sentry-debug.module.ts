import { Module } from '@nestjs/common';

import { InitializableModule } from '@app/nest/boot/initializable.module';

import { SentryDebugController } from './sentry-debug.controller';

@Module({
  controllers: [SentryDebugController],
})
export class SentryDebugModule extends InitializableModule {
  protected override async initialize(): Promise<void> {
    if (process.env.SENTRY_DSN) {
      this.logger.info`Sentry debug endpoint available at GET /sentry-debug (localhost only)`;
    }
  }
}
