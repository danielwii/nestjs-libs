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
import { configureLogging, LogtapeNestLogger } from '@app/nest/logging';

import { addGrpcHealthService } from './grpc-health';

import fs from 'node:fs';
import os from 'node:os';

import dedent from 'dedent';
import { DateTime } from 'luxon';
import { ServerReflection, ServerReflectionService } from 'nice-grpc-server-reflection';

import type { Server, ServerDuplexStream } from '@grpc/grpc-js';
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
 * 将 @grpc/grpc-js 的 bidi stream 转为 AsyncIterable
 * 用于适配 nice-grpc 的 async generator 接口
 */
function callToAsyncIterable<T>(call: {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}): AsyncIterable<T> {
  const queue: Array<{ value: T; done: false } | { value: undefined; done: true }> = [];
  let resolve: ((v: { value: T; done: false } | { value: undefined; done: true }) => void) | null = null;

  call.on('data', (data: unknown) => {
    const item = { value: data as T, done: false as const };
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  });

  call.on('end', () => {
    const item = { value: undefined, done: true as const };
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const queued = queue.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

/**
 * 从 FileDescriptorSet 二进制中提取所有 service 全限定名
 * 使用 @grpc/proto-loader 解析，从 PackageDefinition 中提取 service 路径
 */
function extractServiceNames(protoset: Buffer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
  const protoLoader: typeof import('@grpc/proto-loader') = require('@grpc/proto-loader');
  const pkg = protoLoader.loadFileDescriptorSetFromBuffer(protoset);
  const serviceNames = new Set<string>();
  for (const key of Object.keys(pkg)) {
    const def = pkg[key];
    // service definition 是对象且不含 requestStream（区分 service 和 method）
    if (def && typeof def === 'object' && !('requestStream' in def)) {
      serviceNames.add(key);
    }
  }
  return [...serviceNames];
}

/**
 * 将预编译 descriptor set 注册为 gRPC reflection service
 * 使用 nice-grpc-server-reflection 直接服务原始字节，绕过 protobufjs roundtrip bug
 */
function addDescriptorSetReflection(server: Pick<Server, 'addService'>, descriptorSetPath: string): void {
  const protoset = fs.readFileSync(descriptorSetPath);
  const serviceNames = extractServiceNames(protoset);
  const impl = ServerReflection(protoset, serviceNames);

  // nice-grpc ServiceDefinition → @grpc/grpc-js addService 需要类型断言
  // nice-grpc 的 async generator handler → @grpc/grpc-js 的 bidi stream callback
  server.addService(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    ServerReflectionService as any,
    {
      serverReflectionInfo: (call: ServerDuplexStream<unknown, unknown>) => {
        void (async () => {
          try {
            const requests = callToAsyncIterable(call);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
            for await (const response of impl.serverReflectionInfo(requests as any, {} as any)) {
              call.write(response);
            }
          } catch (err) {
            Logger.error(`Reflection error: ${err instanceof Error ? err.message : String(err)}`, 'gRPC-Reflection');
          } finally {
            call.end();
          }
        })();
      },
    },
  );
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
  await configureLogging(logLevel);
  const app = await NestFactory.create<NestExpressApplication>(wrapWithBootModule(AppModule), {
    logger: new LogtapeNestLogger(),
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

  // gRPC Health Service: 追踪 shutdown 状态，SIGTERM 后返回 NOT_SERVING
  let grpcShuttingDown = false;
  process.on('SIGTERM', () => {
    grpcShuttingDown = true;
  });

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        package: options.grpc.package,
        protoPath: options.grpc.protoPath,
        url: `0.0.0.0:${grpcPort}`,
        loader: options.grpc.loader,
        // 滚动更新时发 GOAWAY 并等待在途 stream 完成，而非 forceShutdown 立即断开
        gracefulShutdown: true,
        // gRPC reflection + health: 使用预编译 descriptor set
        onLoadPackageDefinition: options.grpc.descriptorSetPath
          ? (_pkg: PackageDefinition, server: Pick<Server, 'addService'>) => {
              const dsPath = options.grpc.descriptorSetPath as string;
              // Reflection service（grpcurl / grpc-client-cli 等工具发现服务）
              if (enableReflection) {
                addDescriptorSetReflection(server, dsPath);
              }
              // Health service（grpc.health.v1.Health/Check）
              addGrpcHealthService(server, dsPath, () => grpcShuttingDown);
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
