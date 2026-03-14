/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Layer types require `any` for generic bootstrap functions that accept arbitrary Layer compositions */

/**
 * Effect Bootstrap
 *
 * 对标 @app/nest/boot 的 bootstrap / simpleBootstrap / grpcBootstrap：
 * - bootstrap()       → HttpApi 声明式 API（对标 NestJS bootstrap）
 * - simpleBootstrap() → HttpRouter 轻量模式（对标 NestJS simpleBootstrap）
 * - rpcBootstrap()    → @effect/rpc 微服务（对标 NestJS grpcBootstrap）
 *
 * 自动注入（对标 NestJS BootModule）：
 * - HealthRegistryLive（addon 自动注册 health check）
 * - FullLoggerLayer（dev pretty / prod JSON）
 * - CORS middleware（可选）
 * - BunHttpServer + BunRuntime
 *
 * @example
 * ```ts
 * // HttpApi 模式（DDD 项目）
 * bootstrap({
 *   api: Api,
 *   handlers: InterfaceLive,
 *   layers: Layer.mergeAll(InfrastructureLive, CoreLive, ...),
 * });
 *
 * // HttpRouter 模式（简单项目）
 * simpleBootstrap(RouterLive);
 *
 * // RPC 模式（微服务）
 * rpcBootstrap({
 *   rpc: RpcLayer,
 *   layers: InfrastructureLive,
 * });
 * ```
 */

import { FullLoggerLayer, Port } from '../core';
import { HealthRegistryLive } from '../health';

import { HttpApiBuilder, HttpMiddleware, HttpRouter, HttpServer } from '@effect/platform';
import { BunHttpServer, BunRuntime } from '@effect/platform-bun';
import { RpcSerialization, RpcServer } from '@effect/rpc';
import type { Config} from 'effect';
import { Effect, Layer } from 'effect';

// ==================== Internal ====================

/** 组合 Layer + HealthRegistry + Logger → launch */
const launch = (serverLive: Layer.Layer<never, any, any>, appLayers?: Layer.Layer<any, any, any>) => {
  const composed = appLayers
    ? serverLive.pipe(Layer.provide(appLayers), Layer.provide(HealthRegistryLive), Layer.provide(FullLoggerLayer()))
    : serverLive.pipe(Layer.provide(HealthRegistryLive), Layer.provide(FullLoggerLayer()));

  (composed as unknown as Layer.Layer<never>).pipe(Layer.launch, BunRuntime.runMain);
};

// ==================== HttpApi Bootstrap ====================

/**
 * HttpApi 声明式 bootstrap
 *
 * 对标 NestJS 的 `bootstrap(AppModule)`：
 * 1. HttpApiBuilder.api + handlers → API 实现
 * 2. HttpApiBuilder.serve + CORS + logging middleware
 * 3. HealthRegistryLive + BunHttpServer + FullLoggerLayer
 * 4. BunRuntime.runMain
 */
export function bootstrap<HOut, HE, HIn, LOut, LE, LIn>(config: {
  /** HttpApi 契约定义 */
  api: any;
  /** Interface Layer（HttpApiGroup handlers） */
  handlers: Layer.Layer<HOut, HE, HIn>;
  /** DDD 层组合 */
  layers?: Layer.Layer<LOut, LE, LIn>;
  /** 端口配置，默认 Port（fallback 3100） */
  port?: Config.Config<number>;
  /** 是否启用 CORS，默认 true */
  cors?: boolean;
}): void {
  const port = config.port ?? Port;
  const enableCors = config.cors ?? true;

  const ApiLive = HttpApiBuilder.api(config.api).pipe(Layer.provide(config.handlers as Layer.Layer<any, any, any>));

  const ServerLive = Layer.unwrapEffect(
    Effect.map(port, (p) => {
      const base = HttpApiBuilder.serve(HttpMiddleware.logger);
      const withCors = enableCors ? base.pipe(Layer.provide(HttpApiBuilder.middlewareCors())) : base;
      return withCors.pipe(
        Layer.provide(ApiLive),
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port: p })),
      );
    }),
  );

  launch(ServerLive, config.layers as Layer.Layer<any, any, any> | undefined);
}

// ==================== HttpRouter Bootstrap ====================

/**
 * HttpRouter 轻量 bootstrap
 *
 * 对标 NestJS 的 `simpleBootstrap(AppModule)`：
 * 1. HttpServer.serve（HttpRouter 模式）
 * 2. HealthRegistryLive + BunHttpServer + FullLoggerLayer
 * 3. BunRuntime.runMain
 */
export function simpleBootstrap<ROut, E, RIn, LOut, LE, LIn>(
  routerLive: Layer.Layer<ROut, E, RIn>,
  options?: {
    /** 端口配置，默认 Port */
    port?: Config.Config<number>;
    /** 额外 Layer */
    layers?: Layer.Layer<LOut, LE, LIn>;
  },
): void {
  const port = options?.port ?? Port;

  const ServerLive = Layer.unwrapEffect(
    Effect.map(port, (p) =>
      (routerLive as Layer.Layer<any, any, any>).pipe(
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port: p })),
      ),
    ),
  );

  launch(ServerLive, options?.layers as Layer.Layer<any, any, any> | undefined);
}

// ==================== RPC Bootstrap ====================

/**
 * @effect/rpc 微服务 bootstrap
 *
 * 对标 NestJS 的 `grpcBootstrap(AppModule, options)`：
 * - Schema-based RPC over HTTP（替代 protobuf + gRPC wire format）
 * - 类型安全来自 TypeScript 编译期，不需要代码生成
 * - 服务发现通过共享 Schema 包（替代 gRPC reflection）
 * - 序列化用 NDJSON（支持流式），不用 protobuf binary
 *
 * @example
 * ```ts
 * // contract/rpcs.ts — RPC 契约定义（共享包）
 * export class UserRpcs extends RpcGroup.make(
 *   Rpc.make("GetUser", {
 *     success: User,
 *     error: NotFoundError,
 *     payload: { id: Schema.String },
 *   }),
 * ) {}
 *
 * // handlers.ts — 实现
 * const UserHandlers = UserRpcs.toLayer({
 *   GetUser: ({ id }) => Effect.gen(function* () { ... }),
 * });
 *
 * // main.ts
 * rpcBootstrap({
 *   rpc: RpcServer.layer(UserRpcs).pipe(Layer.provide(UserHandlers)),
 *   layers: InfrastructureLive,
 * });
 * ```
 */
export function rpcBootstrap<ROut, RE, RIn, LOut, LE, LIn>(config: {
  /** RpcServer.layer(RpcGroup) 的结果 */
  rpc: Layer.Layer<ROut, RE, RIn>;
  /** RPC endpoint path，默认 "/rpc" */
  path?: string;
  /** DDD 层组合 */
  layers?: Layer.Layer<LOut, LE, LIn>;
  /** 端口配置，默认 Port */
  port?: Config.Config<number>;
  /** 序列化格式，默认 NDJSON（支持流式） */
  serialization?: 'ndjson' | 'json';
}): void {
  const port = config.port ?? Port;
  const rpcPath = config.path ?? '/rpc';
  const serializationLayer =
    config.serialization === 'json' ? RpcSerialization.layerJson : RpcSerialization.layerNdjson;

  const HttpProtocol = RpcServer.layerProtocolHttp({ path: rpcPath as any }).pipe(Layer.provide(serializationLayer));

  const ServerLive = Layer.unwrapEffect(
    Effect.map(port, (p) =>
      HttpRouter.Default.serve().pipe(
        Layer.provide(config.rpc as Layer.Layer<any, any, any>),
        Layer.provide(HttpProtocol),
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port: p })),
      ),
    ),
  );

  launch(ServerLive, config.layers as Layer.Layer<any, any, any> | undefined);
}
