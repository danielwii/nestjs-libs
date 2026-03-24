/**
 * Scheduler Bootstrap — scheduler 独立进程专用
 *
 * 与 bootstrap 的区别：
 * - 包含：NestJS 基础设施（ExceptionFilter、Interceptors、ShutdownHooks、ValidationPipe）
 * - 包含：OTel tracing（dev 模式 otelTraceMiddleware，prod 模式 Sentry httpIntegration）
 * - 不包含：HTTP middleware（CORS、helmet、morgan、compression、cookie、session、graphqlUpload）
 * - 不包含：LLM validation、DB migration、gRPC microservice
 *
 * 使用方式：
 *   bun --preload ./libs/instrument.ts src/scheduler.ts
 *
 * ```typescript
 * import { schedulerBootstrap } from '@app/nest/boot';
 * import { SchedulerAppModule } from '@/scheduler/scheduler-app.module';
 * await schedulerBootstrap(SchedulerAppModule);
 * ```
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';

import { SysEnv } from '@app/env';
import { wrapWithBootModule } from '@app/nest/boot/bootstrap';
import { runApp } from '@app/nest/boot/lifecycle';
import { AnyExceptionFilter } from '@app/nest/exceptions/any-exception.filter';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';
import { VisitorInterceptor } from '@app/nest/interceptors/visitor.interceptor';
import { configureLogging, LogtapeNestLogger } from '@app/nest/logging';
import { otelTraceMiddleware } from '@app/nest/middleware/otel-trace.middleware';
import { getAppLogger } from '@app/utils/app-logger';

import os from 'node:os';

import { DateTime } from 'luxon';

import type { DynamicModule, ForwardReference, INestApplication, LogLevel, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

const bootstrapLogger = getAppLogger('boot', 'SchedulerBootstrap');

type IEntryNestModule = Type<unknown> | DynamicModule | ForwardReference | Promise<IEntryNestModule>;

export interface SchedulerBootstrapOptions {
  packageJson?: {
    name: string;
    version: string;
  };
}

export async function schedulerBootstrap(
  AppModule: IEntryNestModule,
  onInit?: (app: INestApplication) => Promise<void>,
  options?: SchedulerBootstrapOptions,
) {
  const now = Date.now();
  const logLevel: LogLevel = SysEnv.LOG_LEVEL;

  await configureLogging(logLevel);
  const app = await NestFactory.create<NestExpressApplication>(wrapWithBootModule(AppModule), {
    logger: new LogtapeNestLogger(),
  });

  app.useGlobalPipes(new ValidationPipe({ enableDebugMessages: true, transform: true, whitelist: true }));
  app.useGlobalFilters(new AnyExceptionFilter(app));
  app.useGlobalInterceptors(new GraphqlAwareClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalInterceptors(new VisitorInterceptor());
  app.useGlobalInterceptors(new LoggerInterceptor());
  app.enableShutdownHooks();
  app.disable('x-powered-by');

  // OTel tracing — Sentry 未接管 OTel 时使用 otelTraceMiddleware
  if (!process.env.SENTRY_DSN) {
    bootstrapLogger.info`[Config] OTel HTTP tracing via lightweight otelTraceMiddleware (no Sentry)`;
    app.use(otelTraceMiddleware);
  }

  if (onInit) await onInit(app);

  const port = SysEnv.PORT;

  await runApp(app)
    .listen(port)
    .then(() => {
      const startTime = DateTime.utc();
      const nodeVersion = process.version;
      const bunVersion =
        'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
      const runtimeVersions = bunVersion ? `Node ${nodeVersion} / Bun ${bunVersion}` : `Node ${nodeVersion}`;

      bootstrapLogger.info`🦋 [Scheduler] Scheduler process started successfully`;
      bootstrapLogger.info`┌─ 配置 ─────────────────────────────────────────────────`;
      bootstrapLogger.info`│ Mode: scheduler`;
      bootstrapLogger.info`│ Env: ${SysEnv.environment.env} (isProd=${SysEnv.environment.isProd})`;
      bootstrapLogger.info`│ Doppler: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}`;
      bootstrapLogger.info`├─ 应用 ─────────────────────────────────────────────────`;
      bootstrapLogger.info`│ App: ${options?.packageJson?.name ?? 'unknown'}-v${options?.packageJson?.version ?? 'unknown'}`;
      bootstrapLogger.info`│ Host: ${os.hostname()}`;
      bootstrapLogger.info`│ Port: ${port}`;
      bootstrapLogger.info`│ PID: ${process.pid}`;
      bootstrapLogger.info`├─ 运行时 ───────────────────────────────────────────────`;
      bootstrapLogger.info`│ Platform: ${process.platform}`;
      bootstrapLogger.info`│ Runtime: ${runtimeVersions}`;
      bootstrapLogger.info`│ Time: ${startTime.setZone(SysEnv.TZ).toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone(SysEnv.TZ).zoneName})`;
      bootstrapLogger.info`└─ Startup: ${Date.now() - now}ms`;
    });

  return app;
}
