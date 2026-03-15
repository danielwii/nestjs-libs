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

import { FullLoggerLayer, Port, ShutdownDrainMs } from '../core';
import { HealthRegistry, HealthRegistryLive } from '../health';

import { HttpApiBuilder, HttpMiddleware, HttpRouter, HttpServer } from '@effect/platform';
import { BunHttpServer, BunRuntime } from '@effect/platform-bun';
import { RpcSerialization, RpcServer } from '@effect/rpc';
import { Effect, Layer } from 'effect';

import type { Config } from 'effect';

// ==================== Internal ====================

/**
 * 组合 Layer + HealthRegistry + Logger → launch
 *
 * ## Graceful Shutdown（K8s 流量排空）
 *
 * 两个阶段，解决两个不同的问题：
 *
 * ### Phase 1: 停止接受新流量
 *
 * ```
 * SIGTERM → markShuttingDown()
 *   → /health/ready 返回 { status: "not_ready" }
 *   → K8s 从 Service endpoints 移除 pod
 *   → 新请求不再路由到此 pod
 * ```
 *
 * 此时 HTTP server 仍在运行，已建立连接的请求继续处理。
 *
 * ### Phase 2: 等待已有流量排空
 *
 * ```
 * sleep(SHUTDOWN_DRAIN_MS)
 *   → in-flight 请求继续处理直到完成或超时
 *   → AI streaming 场景（诊断/生成）可能需要 60-120s
 *   → 超时后无论是否还有请求，开始关闭资源
 * ```
 *
 * drain 结束后，Layer scoped finalizers 逆序执行（Prisma、Redis、gRPC 断开），进程退出。
 *
 * ### 配置
 *
 * - `SHUTDOWN_DRAIN_MS`：drain 等待时间（默认 5000ms，AI stream 建议 60000-120000ms）
 * - K8s `terminationGracePeriodSeconds` 必须 > `SHUTDOWN_DRAIN_MS` + preStop 时间
 *
 * ### 完整时序
 *
 * ```
 * t=0s   SIGTERM 到达
 * t=0s   ① markShuttingDown() — 停止接受新流量
 * t=0~5s K8s 轮询 readiness，发现 not_ready，移除 endpoints — 新流量停止
 * t=Ns   ② sleep(SHUTDOWN_DRAIN_MS) 结束 — 已有流量排空超时
 * t=Ns   ③ Prisma.$disconnect(), Redis.disconnect() — 关闭资源
 * t=Ns   进程退出
 * ```
 */
const launch = (serverLive: Layer.Layer<never, any, any>, appLayers?: Layer.Layer<any, any, any>) => {
  const composed = appLayers
    ? serverLive.pipe(Layer.provide(appLayers), Layer.provide(HealthRegistryLive), Layer.provide(FullLoggerLayer()))
    : serverLive.pipe(Layer.provide(HealthRegistryLive), Layer.provide(FullLoggerLayer()));

  const program = Effect.gen(function* () {
    const registry = yield* HealthRegistry;
    const drainMs = yield* ShutdownDrainMs;

    // Finalizer 在 SIGTERM 中断 Effect.never 后执行。
    // 因为是最后注册的 finalizer，所以最先执行（逆序），先于 Layer 的资源清理。
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Phase 1: 停止接受新流量
        // markShuttingDown 让 /health/ready 返回 not_ready，K8s 据此摘流量。
        // 此刻 HTTP server 仍在运行，已建立连接的 in-flight 请求不受影响。
        yield* registry.markShuttingDown();
        yield* Effect.log('Phase 1: readiness → not_ready, no new traffic will be routed');

        // Phase 2: 等待已有流量排空
        // sleep 期间 HTTP server 继续服务 in-flight 请求（含 AI streaming）。
        // drain 超时后才关闭资源，未完成的请求将因连接断开而终止。
        yield* Effect.log(`Phase 2: draining in-flight requests (${drainMs}ms)...`);
        yield* Effect.sleep(`${drainMs} millis`);

        yield* Effect.log('Drain complete, proceeding to close resources');
      }),
    );

    yield* Effect.never;
  });

  program.pipe(Effect.scoped, Effect.provide(composed as unknown as Layer.Layer<HealthRegistry>), BunRuntime.runMain);
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
