import { Module } from '@nestjs/common';

import { LoggerInjector } from './logger.injector';

import type { Injector } from './injector';

/**
 * Trace Module
 *
 * 自动注入 traceId 到日志，便于请求链路追踪。
 *
 * 使用方式：
 * ```typescript
 * import { TraceModule } from '@app/nest/trace';
 *
 * @Module({
 *   imports: [TraceModule],
 * })
 * export class AppModule {}
 * ```
 *
 * 或通过 BootModule 统一引入：
 * ```typescript
 * import { BootModule } from '@app/nest/boot';
 *
 * @Module({
 *   imports: [BootModule],
 * })
 * export class AppModule {}
 * ```
 */
@Module({
  providers: [
    LoggerInjector,
    {
      provide: 'injectors',
      useFactory: async (...injectors: Injector[]) => {
        for (const injector of injectors) await injector.inject();
      },
      inject: [LoggerInjector],
    },
  ],
})
export class TraceModule {}
