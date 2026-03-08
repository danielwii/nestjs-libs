import { Logger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';

import { SysEnv } from '@app/env';
import { BootModule } from '@app/nest/boot/boot.module';
import { runApp } from '@app/nest/boot/lifecycle';
import { GrpcExceptionFilter } from '@app/nest/exceptions/grpc-exception.filter';
import { GrpcServiceTokenGuard } from '@app/nest/guards';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';

import fs from 'node:fs';
import os from 'node:os';

import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import dedent from 'dedent';
import { DateTime } from 'luxon';

import type { Server } from '@grpc/grpc-js';
import type { PackageDefinition } from '@grpc/proto-loader';
import type { DynamicModule, ForwardReference, INestApplication, LogLevel, Type } from '@nestjs/common';
import type { MicroserviceOptions } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';

type IEntryNestModule = Type<unknown> | DynamicModule | ForwardReference | Promise<IEntryNestModule>;

/**
 * 包装用户的 AppModule，自动注入 BootModule
 */
function wrapWithBootModule(AppModule: IEntryNestModule): Type<unknown> {
  @Module({
    imports: [BootModule, AppModule as Type<unknown>],
  })
  class WrappedAppModule {}
  return WrappedAppModule;
}

const allLogLevels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export interface GrpcBootstrapOptions {
  packageJson?: {
    name: string;
    version: string;
  };
  /** gRPC 配置 */
  grpc: {
    /** gRPC 包名 */
    package: string | string[];
    /** Proto 文件路径 */
    protoPath: string | string[];
    /** 预编译 FileDescriptorSet 路径（绕过 protobufjs map entry name bug） */
    descriptorSetPath?: string;
    /** gRPC 服务端口，默认 50051 */
    port?: number;
    /** 额外的 loader 选项 */
    loader?: object;
    /** 是否启用 gRPC reflection，默认 true */
    reflection?: boolean;
  };
  /** HTTP 健康检查端口，默认 3000 */
  httpPort?: number;
  /** 服务提供者标识（用于异常追踪），默认从 grpc.package 提取 */
  provider?: string;
}

/**
 * gRPC 服务启动函数
 *
 * 设计意图：
 * - 专为纯 gRPC 服务设计，不包含 HTTP 专用中间件
 * - 同时启动 HTTP 服务用于健康检查
 * - 支持 OpenTelemetry（通过 instrument.js preload）
 *
 * 包含：
 * - ValidationPipe（参数验证）
 * - AnyExceptionFilter（统一异常处理）
 * - LoggerInterceptor（请求日志）
 * - 进程信号处理（SIGTERM/SIGINT 优雅关闭）
 *
 * 不包含（与 bootstrap 的区别）：
 * - helmet, CORS, session, morgan 等 HTTP 中间件
 * - GraphQL upload 中间件
 * - LLM 配置验证
 */
export async function grpcBootstrap(
  AppModule: IEntryNestModule,
  options: GrpcBootstrapOptions,
  onInit?: (app: INestApplication) => Promise<void>,
) {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is not set');

  const now = Date.now();
  const logLevel: LogLevel = SysEnv.LOG_LEVEL;
  const levels = allLogLevels.slice(allLogLevels.indexOf(logLevel), allLogLevels.length);

  const notShowLogLevels = allLogLevels.slice(0, allLogLevels.indexOf(logLevel));
  Logger.log(`[Config] Log level set to "${SysEnv.LOG_LEVEL}" - Enabled levels: ${levels.join(', ')}`, 'Bootstrap');
  if (notShowLogLevels.length) {
    Logger.warn(`[Config] Disabled log levels: ${notShowLogLevels.join(', ')}`, 'Bootstrap');
  }

  // 创建 HTTP 应用（用于健康检查），自动注入 BootModule
  const app = await NestFactory.create<NestExpressApplication>(wrapWithBootModule(AppModule), {
    logger: levels,
  });

  // 提取 provider 名称（用于异常追踪）
  const provider =
    options.provider ??
    (Array.isArray(options.grpc.package)
      ? (options.grpc.package[0]?.split('.').pop() ?? 'unknown')
      : (options.grpc.package.split('.').pop() ?? 'unknown'));

  // 基础配置
  app.useGlobalPipes(new ValidationPipe({ enableDebugMessages: true, transform: true, whitelist: true }));
  // gRPC 服务只需要 GrpcExceptionFilter（不需要 AnyExceptionFilter，那是 HTTP/GraphQL 用的）
  app.useGlobalFilters(new GrpcExceptionFilter(provider));
  app.useGlobalGuards(new GrpcServiceTokenGuard());
  app.useGlobalInterceptors(new GraphqlAwareClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalInterceptors(new LoggerInterceptor());
  app.enableShutdownHooks();

  // 配置 gRPC 微服务
  // inheritAppConfig: true 使全局 interceptors/guards/pipes 也应用于微服务
  const grpcPort = options.grpc.port ?? SysEnv.GRPC_PORT;
  const enableReflection = options.grpc.reflection !== false; // 默认启用

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: options.grpc.package,
        protoPath: options.grpc.protoPath,
        url: `0.0.0.0:${grpcPort}`,
        loader: options.grpc.loader,
        // 启用 gRPC reflection，支持 grpcurl list 等命令
        onLoadPackageDefinition: enableReflection
          ? (pkg: PackageDefinition, server: Pick<Server, 'addService'>) => {
              if (options.grpc.descriptorSetPath) {
                // 预编译 descriptor 绕过 protobufjs map entry name bug (#519)
                const buf = fs.readFileSync(options.grpc.descriptorSetPath);
                const descriptorPkg = protoLoader.loadFileDescriptorSetFromBuffer(buf, options.grpc.loader);
                new ReflectionService(descriptorPkg).addToServer(server);
              } else {
                // fallback: 运行时解析（map 字段 reflection 可能不正确）
                new ReflectionService(pkg).addToServer(server);
              }
            }
          : undefined,
      },
    },
    { inheritAppConfig: true },
  );

  // 自定义初始化
  if (onInit) await onInit(app);

  // 启动 gRPC 微服务
  await app.startAllMicroservices();

  // 启动 HTTP 服务（健康检查）
  const httpPort = options.httpPort ?? SysEnv.PORT;
  await runApp(app)
    .listen(httpPort)
    .then(() => {
      const startTime = DateTime.utc();

      // 获取运行时版本信息
      const nodeVersion = process.version;
      const bunVersion =
        'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
      const runtimeVersions = bunVersion ? `Node ${nodeVersion} / Bun ${bunVersion}` : `Node ${nodeVersion}`;

      Logger.log(
        dedent`🦋 [Server] gRPC Server started successfully
          ┌─ 环境配置 ─────────────────────────────────────────────
          │ Node Runtime (NODE_ENV): ${process.env.NODE_ENV}
          │ Business Env (ENV): ${SysEnv.environment.env} → isProd=${SysEnv.environment.isProd}
          │ Doppler Env: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}
          ├─ 应用信息 ─────────────────────────────────────────────
          │ App Version: ${options.packageJson?.name ?? 'unknown'}-v${options.packageJson?.version ?? 'unknown'}
          │ Host: ${os.hostname()}
          │ gRPC Port: ${grpcPort}${enableReflection ? ' (reflection enabled)' : ''}
          │ HTTP Port: ${httpPort} (health check)
          │ Service Token: ${process.env.GRPC_SERVICE_TOKEN ? 'configured' : 'not configured'}
          │ PID: ${process.pid}
          ├─ 运行时信息 ───────────────────────────────────────────
          │ Platform: ${process.platform}
          │ Runtime: ${runtimeVersions}
          │ UTC Time: ${startTime.toFormat('yyyy-MM-dd EEEE HH:mm:ss')}
          └─ Startup Time: ${Date.now() - now}ms
        `,
        'Bootstrap',
      );
    });

  return app;
}
