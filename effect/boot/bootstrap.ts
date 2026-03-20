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
 * - HealthRegistry.Default（addon 自动注册 health check）
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

import { f } from '@app/utils/logging';

import { AppConfig, GrpcPort, LogTapeLoggerLayer, Port, ShutdownDrainMs } from '../core';
import { HealthRegistry } from '../health';

import os from 'node:os';

import { HttpApiBuilder, HttpMiddleware, HttpRouter, HttpServer } from '@effect/platform';
import { BunHttpServer, BunRuntime } from '@effect/platform-bun';
import { RpcSerialization, RpcServer } from '@effect/rpc';
import { Config, Effect, Layer, Option } from 'effect';

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
/**
 * MCP 协议 bootstrap
 *
 * MCP (Model Context Protocol) 双 transport 模式：
 * - HTTP SSE：注册 tools/resources/prompts → 启动 HTTP server → 阻塞 → graceful shutdown
 * - stdio：注册 tools/resources/prompts → 运行 stdio handler → 退出
 *
 * Transport 通过 MCP_TRANSPORT env var 切换（默认 "http"）。
 *
 * @example
 * ```ts
 * mcpBootstrap({
 *   setup: Effect.gen(function* () {
 *     yield* registerAllTools;
 *     yield* registerResources;
 *     yield* registerPrompts;
 *   }),
 *   http: startHttpServer,
 *   stdio: runStdio,
 *   layers: Layer.mergeAll(InfrastructureLive, McpServerLive),
 * });
 * ```
 */
export function mcpBootstrap<LOut = never, LE = never, LIn = never>(config: {
  /** 初始化逻辑（注册 tools/resources/prompts） */
  setup: Effect.Effect<any, any, any>;
  /** HTTP 模式：启动 server 后立即返回（不阻塞），bootstrap 自动阻塞等待 SIGTERM */
  http: Effect.Effect<any, any, any>;
  /** stdio 模式：运行 stdio handler，阻塞直到结束 */
  stdio: Effect.Effect<any, any, any>;
  /** 应用 Layer（infrastructure + MCP server 等） */
  layers?: Layer.Layer<LOut, LE, LIn>;
  /** transport env var 名，默认 "MCP_TRANSPORT" */
  transportEnvVar?: string;
}): void {
  const transportConfig = Config.string(config.transportEnvVar ?? 'MCP_TRANSPORT').pipe(Config.withDefault('http'));

  const appLive = config.layers
    ? config.layers.pipe(Layer.provideMerge(HealthRegistry.Default), Layer.provideMerge(LogTapeLoggerLayer))
    : HealthRegistry.Default.pipe(Layer.provideMerge(LogTapeLoggerLayer));

  const program = Effect.gen(function* () {
    const transport = yield* transportConfig;

    // Setup: register tools, resources, prompts
    yield* config.setup.pipe(Effect.withLogSpan('setup'));

    if (transport === 'stdio') {
      yield* startupBanner('MCP (stdio)');
      yield* config.stdio;
    } else {
      yield* config.http;
      yield* startupBanner('MCP (HTTP)');
      yield* gracefulShutdown;
      yield* Effect.never;
    }
  });

  program.pipe(
    Effect.scoped,
    // as any: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
    Effect.provide(appLive as any),
    (effect: any) => {
      BunRuntime.runMain(effect, { disablePrettyLogger: true });
    },
  );
}

// ==================== Startup Helpers ====================

const startupTimestamp = Date.now();

// why: process.env 直接读取 — 这些值在 Logger/Banner 构建时使用，
// 此时 Config Layer 尚未就绪（Logger 必须先于 Config 初始化）
const bunVersion = 'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
const runtimeInfo = bunVersion ? `Node ${process.version} / Bun ${bunVersion}` : `Node ${process.version}`;

/**
 * 启动时打印环境信息 + 安全检查
 *
 * 所有 bootstrap 共用（launch + mcpBootstrap）
 */
const startupBanner = (label: string) =>
  Effect.gen(function* () {
    const { nodeEnv, env, port, logLevel, serviceName } = yield* AppConfig;
    const grpcPort = yield* Config.option(GrpcPort);

    // Env 安全检查：生产模式必须明确指定业务环境
    if (nodeEnv === 'production' && env === 'dev') {
      yield* Effect.logWarning(
        'NODE_ENV=production but ENV=dev (default). Set ENV=prd or ENV=stg to avoid data environment mismatch.',
      );
    }

    const modeDesc =
      nodeEnv === 'production' ? 'production (optimized)' : nodeEnv === 'development' ? 'development (watch)' : 'test';

    const envDesc =
      env === 'prd' ? 'production (real data)' : env === 'stg' ? 'staging (test data)' : 'development (test data)';

    const elapsed = Date.now() - startupTimestamp;
    const isProd = nodeEnv === 'production';

    // 端口行：HTTP + gRPC（有就打）
    const portParts = [f`HTTP: ${port}`];
    const grpcPortValue = Option.getOrUndefined(grpcPort);
    if (grpcPortValue !== undefined) {
      portParts.push(f`gRPC: ${grpcPortValue}`);
    }

    const lines = [
      `${label} started`,
      f`├─ Environment: NODE_ENV=${nodeEnv} (${modeDesc}), ENV=${env} (${envDesc})`,
      f`├─ Service: ${serviceName} | Host: ${os.hostname()} | PID: ${process.pid}`,
      `├─ ${portParts.join(' | ')} | Runtime: ${runtimeInfo}`,
      f`├─ Log Level: ${logLevel}`,
      // why: process.env 直接读取 — 仅用于 banner 显示，非业务逻辑，不值得声明 Config
      f`├─ Body Limit: ${process.env.BODY_SIZE_LIMIT ?? '1mb (default)'}`,
      f`├─ Trust Proxy: ${process.env.TRUST_PROXY ?? 'on'}`,
      f`└─ Startup: ${elapsed}ms`,
    ];

    // dev: 多行可读, prod: 单行 JSON 友好
    if (isProd) {
      yield* Effect.logInfo(lines.join(' | '));
    } else {
      for (const line of lines) {
        yield* Effect.logInfo(line);
      }
    }
  }).pipe(Effect.annotateLogs('module', 'Bootstrap'));

/**
 * Graceful shutdown finalizer — 共用逻辑
 */
const gracefulShutdown = Effect.gen(function* () {
  const registry = yield* HealthRegistry;
  const drainMs = yield* ShutdownDrainMs;

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* registry.markShuttingDown();
      yield* Effect.log('Phase 1: readiness → not_ready, no new traffic will be routed');

      yield* Effect.log(f`Phase 2: draining in-flight requests (${drainMs}ms)...`);
      yield* Effect.sleep(`${drainMs} millis`);

      yield* Effect.log('Drain complete, proceeding to close resources');
    }).pipe(Effect.annotateLogs('module', 'Shutdown')),
  );
});

// ==================== Internal Launch ====================

const launch = (serverLive: Layer.Layer<never, any, any>, appLayers?: Layer.Layer<any, any, any>) => {
  const composed = appLayers
    ? serverLive.pipe(
        Layer.provide(appLayers),
        Layer.provide(HealthRegistry.Default),
        Layer.provide(LogTapeLoggerLayer),
      )
    : serverLive.pipe(Layer.provide(HealthRegistry.Default), Layer.provide(LogTapeLoggerLayer));

  const program = Effect.gen(function* () {
    yield* startupBanner('Server');
    yield* gracefulShutdown;
    yield* Effect.never;
  });

  // as unknown: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
  program.pipe(Effect.scoped, Effect.provide(composed as unknown as Layer.Layer<HealthRegistry>), (effect) => {
    BunRuntime.runMain(effect, { disablePrettyLogger: true });
  });
};

// ==================== HttpApi Bootstrap ====================

/**
 * HttpApi 声明式 bootstrap
 *
 * 对标 NestJS 的 `bootstrap(AppModule)`：
 * 1. HttpApiBuilder.api + handlers → API 实现
 * 2. HttpApiBuilder.serve + CORS + logging middleware
 * 3. HealthRegistry.Default + BunHttpServer + FullLoggerLayer
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

  // as any: HttpApiBuilder.api 的泛型与 Layer.provide 组合时 TSC 无法自动推断
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

  // as any: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
  launch(ServerLive, config.layers as Layer.Layer<any, any, any> | undefined);
}

// ==================== HttpRouter Bootstrap ====================

/**
 * HttpRouter 轻量 bootstrap
 *
 * 对标 NestJS 的 `simpleBootstrap(AppModule)`：
 * 1. HttpServer.serve（HttpRouter 模式）
 * 2. HealthRegistry.Default + BunHttpServer + FullLoggerLayer
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
      // as any: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
      (routerLive as Layer.Layer<any, any, any>).pipe(
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port: p })),
      ),
    ),
  );

  // as any: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
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

  // as any: RpcServer.layerProtocolHttp path 参数类型比实际使用更窄
  const HttpProtocol = RpcServer.layerProtocolHttp({ path: rpcPath as any }).pipe(Layer.provide(serializationLayer));

  const ServerLive = Layer.unwrapEffect(
    Effect.map(port, (p) =>
      HttpRouter.Default.serve().pipe(
        // as any: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
        Layer.provide(config.rpc as Layer.Layer<any, any, any>),
        Layer.provide(HttpProtocol),
        HttpServer.withLogAddress,
        Layer.provide(BunHttpServer.layer({ port: p })),
      ),
    ),
  );

  // as any: Layer 泛型在 composition root 无法精确推断，封闭在入口内部不影响类型安全
  launch(ServerLive, config.layers as Layer.Layer<any, any, any> | undefined);
}
