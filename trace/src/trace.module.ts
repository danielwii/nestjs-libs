import { DynamicModule, Module } from '@nestjs/common';

import { LoggerInjector } from './logger.injector';
import { Injector } from './injector';

/**
 * 自动注入 LoggerInjector，在日志中自动添加 traceId
 */
@Module({})
export class TraceModule {
  static forRootAsync(): DynamicModule {
    return {
      module: TraceModule,
      imports: [],
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
    };
  }
}
