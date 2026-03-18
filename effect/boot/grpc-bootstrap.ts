/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- nice-grpc types don't align strictly */

/**
 * grpcBootstrap — nice-grpc + Effect bootstrap
 *
 * 对标 @app/nest/boot/grpc-bootstrap：
 * - nice-grpc server（proto-based gRPC，非 @effect/rpc）
 * - gRPC reflection（grpcurl list/describe）
 * - gRPC health check（grpc.health.v1.Health，通过 HealthRegistry）
 * - Graceful shutdown（markShuttingDown → drain → server.shutdown/GOAWAY）
 *
 * 自动注入：
 * - HealthRegistry.Default（addon 自动注册 health check）
 * - LogTapeLoggerLayer（dev pretty / prod JSON）
 *
 * @example
 * ```ts
 * import { HealthDefinition, HealthCheckResponse_ServingStatusProto }
 *   from '@app/contract/proto/generated/health';
 *
 * grpcBootstrap({
 *   descriptorSetPath: new URL('../contract/proto/descriptor_set.bin', import.meta.url).pathname,
 *   health: { definition: HealthDefinition, servingStatus: HealthCheckResponse_ServingStatusProto },
 *   services: (server, add) => {
 *     add(WeatherServiceDefinition, weatherController);
 *   },
 *   layers: AppLive,
 * });
 * ```
 */

import { f } from '@app/utils/logging';

import { AppConfig, GrpcPort, LogTapeLoggerLayer, ShutdownDrainMs } from '../core';
import { HealthRegistry } from '../health';

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

import { BunRuntime } from '@effect/platform-bun';
import { Effect, Layer } from 'effect';
import { createServer } from 'nice-grpc';
import { ServerReflection, ServerReflectionService } from 'nice-grpc-server-reflection';

import type { Server as NiceGrpcServer } from 'nice-grpc';

// ==================== Types ====================

export interface GrpcHealthConfig {
  /** grpc.health.v1.Health 的 ServiceDefinition（从 proto generated 导入） */
  definition: any;
  /** HealthCheckResponse_ServingStatusProto enum（SERVING / NOT_SERVING） */
  servingStatus: { SERVING: string; NOT_SERVING: string };
}

export interface GrpcBootstrapConfig {
  /**
   * descriptor_set.bin 路径
   * 用于 gRPC reflection
   */
  descriptorSetPath: string;

  /**
   * gRPC health check 配置
   * 传入 proto generated 的 HealthDefinition + ServingStatus enum
   */
  health: GrpcHealthConfig;

  /**
   * 注册 gRPC services
   *
   * `add` 是类型宽松的 wrapper（nice-grpc ServiceDefinition 和 controller 类型不严格匹配）
   */
  services: (server: NiceGrpcServer, add: (def: any, impl: any) => void) => void;

  /**
   * 启动前的初始化逻辑（读 Config、实例化 providers 等）
   * 在 gRPC server 创建前执行
   */
  setup?: Effect.Effect<void, any, any>;

  /** 应用 Layer（infrastructure 等） */
  layers?: Layer.Layer<any, any, any>;

  /** 是否启用 gRPC reflection，默认 true */
  reflection?: boolean;
}

// ==================== Helpers ====================

const startupTimestamp = Date.now();
const bunVersion = 'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
const runtimeInfo = bunVersion ? `Node ${process.version} / Bun ${bunVersion}` : `Node ${process.version}`;

function extractServiceNames(descriptorSetPath: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
  const protoLoader: typeof import('@grpc/proto-loader') = require('@grpc/proto-loader');
  const protoset = fs.readFileSync(descriptorSetPath);
  const pkg = protoLoader.loadFileDescriptorSetFromBuffer(protoset);
  const serviceNames = new Set<string>();
  for (const key of Object.keys(pkg)) {
    const def = pkg[key];
    // service 的值是对象，其子属性（method）包含 requestStream
    // message type 的值是构造函数（有 prototype），不是 plain object
    if (def && typeof def === 'object') {
      const values = Object.values(def as Record<string, unknown>);
      const hasMethod = values.some(
        (v) => v && typeof v === 'object' && 'requestStream' in (v as Record<string, unknown>),
      );
      if (hasMethod) {
        serviceNames.add(key);
      }
    }
  }
  return [...serviceNames];
}

// ==================== Bootstrap ====================

export function grpcBootstrap(config: GrpcBootstrapConfig): void {
  const enableReflection = config.reflection !== false;

  const appLive = config.layers
    ? config.layers.pipe(Layer.provideMerge(HealthRegistry.Default), Layer.provideMerge(LogTapeLoggerLayer))
    : HealthRegistry.Default.pipe(Layer.provideMerge(LogTapeLoggerLayer));

  const program = Effect.gen(function* () {
    // Setup (read config, instantiate providers, etc.)
    if (config.setup) {
      yield* config.setup.pipe(Effect.withLogSpan('setup'));
    }

    // Read system config
    const { nodeEnv, env, port: httpPort, logLevel, serviceName } = yield* AppConfig;
    const grpcPort = yield* GrpcPort;
    const drainMs = yield* ShutdownDrainMs;
    const registry = yield* HealthRegistry;

    // Create gRPC server
    const server = createServer();
    const add = (def: any, impl: any) => {
      server.add(def, impl);
    };

    // Register user services
    config.services(server, add);

    // Register gRPC Health Check (grpc.health.v1)
    const { definition: healthDef, servingStatus } = config.health;
    add(healthDef, {
      async check() {
        const shuttingDown = await Effect.runPromise(registry.isShuttingDown());
        if (shuttingDown) {
          return { status: servingStatus.NOT_SERVING };
        }
        const checks = await Effect.runPromise(registry.checkAll('readiness'));
        const allHealthy = checks.length === 0 || checks.every((c: { healthy: boolean }) => c.healthy);
        return {
          status: allHealthy ? servingStatus.SERVING : servingStatus.NOT_SERVING,
        };
      },
    });

    // Register gRPC Reflection
    if (enableReflection) {
      try {
        const protoset = fs.readFileSync(config.descriptorSetPath);
        const serviceNames = extractServiceNames(config.descriptorSetPath);
        const reflectionImpl = ServerReflection(protoset, serviceNames);
        server.add(ServerReflectionService as any, reflectionImpl as any);
        yield* Effect.logDebug(f`gRPC reflection enabled (${serviceNames.length} services)`);
      } catch (err) {
        yield* Effect.logWarning(f`gRPC reflection failed: ${err}`);
      }
    }

    // Start gRPC server
    yield* Effect.promise(() => server.listen(`0.0.0.0:${grpcPort}`));
    yield* Effect.logInfo(
      f`gRPC server listening on port ${grpcPort}${enableReflection ? ' (reflection enabled)' : ''}`,
    );

    // Start HTTP health server
    // 对标 NestJS HealthController：三层 K8s 健康检查端点
    // - GET /health          — liveness（进程活着）
    // - GET /health/ready    — readiness（DB/Redis + shutdown），失败 → K8s 摘流量
    // - GET /health/topology — 下游 gRPC 可达性，失败 → 503（监控告警）
    const TOPOLOGY_TIMEOUT_MS = 5000;

    const json = (res: http.ServerResponse, status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const toChecksMap = (checks: ReadonlyArray<{ name: string }>) => {
      const map: Record<string, unknown> = {};
      for (const c of checks) map[c.name] = c;
      return map;
    };

    const handleHealth = (_req: http.IncomingMessage, res: http.ServerResponse) =>
      Effect.sync(() => {
        json(res, 200, { status: 'ok' });
      });

    const handleReady = (_req: http.IncomingMessage, res: http.ServerResponse) =>
      Effect.gen(function* () {
        const shuttingDown = yield* registry.isShuttingDown();
        if (shuttingDown) {
          json(res, 503, { status: 'shutting_down' });
          return;
        }

        const checks = yield* registry.checkAll('readiness');
        const allHealthy = checks.length === 0 || checks.every((c) => c.healthy);
        json(res, allHealthy ? 200 : 503, {
          status: allHealthy ? 'ready' : 'not_ready',
          checks: toChecksMap(checks),
        });
      });

    const handleTopology = (_req: http.IncomingMessage, res: http.ServerResponse) =>
      Effect.gen(function* () {
        const indicators = yield* registry.getByType('topology');
        if (indicators.length === 0) {
          json(res, 200, { status: 'ok', checks: {} });
          return;
        }

        const results = yield* Effect.all(
          indicators.map((i) => i.check()),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.timeout(`${TOPOLOGY_TIMEOUT_MS} millis`),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              const message = err instanceof Error ? err.message : String(err);
              json(res, 503, { status: 'down', error: message });
              return null;
            }),
          ),
        );

        if (results === null) return; // already responded in catchAll

        const checksMap = toChecksMap(results);
        const healthyCount = results.filter((r) => r.healthy).length;
        if (healthyCount === results.length) {
          json(res, 200, { status: 'ok', checks: checksMap });
        } else {
          json(res, 503, { status: healthyCount === 0 ? 'down' : 'degraded', checks: checksMap });
        }
      });

    const httpServer = http.createServer((req, res) => {
      const url = req.url ?? '';
      const handler =
        url === '/health'
          ? handleHealth(req, res)
          : url === '/health/ready'
            ? handleReady(req, res)
            : url === '/health/topology'
              ? handleTopology(req, res)
              : Effect.sync(() => {
                  json(res, 404, { error: 'Not Found' });
                });

      void Effect.runPromise(handler);
    });

    yield* Effect.promise(() => new Promise<void>((resolve) => httpServer.listen(httpPort, '0.0.0.0', resolve)));
    yield* Effect.logInfo(f`HTTP health server listening on port ${httpPort}`);

    // Startup banner
    const elapsed = Date.now() - startupTimestamp;
    const isProd = nodeEnv === 'production';

    const modeDesc =
      nodeEnv === 'production' ? 'production (optimized)' : nodeEnv === 'development' ? 'development (watch)' : 'test';
    const envDesc =
      env === 'prd' ? 'production (real data)' : env === 'stg' ? 'staging (test data)' : 'development (test data)';

    const lines = [
      'gRPC Server started',
      f`├─ Environment: NODE_ENV=${nodeEnv} (${modeDesc}), ENV=${env} (${envDesc})`,
      f`├─ Service: ${serviceName} | Host: ${os.hostname()} | PID: ${process.pid}`,
      f`├─ HTTP: ${httpPort} | gRPC: ${grpcPort}${enableReflection ? ' (reflection)' : ''} | Runtime: ${runtimeInfo}`,
      f`├─ Log Level: ${logLevel}`,
      f`└─ Startup: ${elapsed}ms`,
    ];

    if (isProd) {
      yield* Effect.logInfo(lines.join(' | '));
    } else {
      for (const line of lines) {
        yield* Effect.logInfo(line);
      }
    }

    // Graceful shutdown
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* registry.markShuttingDown();
        yield* Effect.logInfo('Phase 1: readiness → not_ready, gRPC health → NOT_SERVING');

        yield* Effect.logInfo(f`Phase 2: draining in-flight requests (${drainMs}ms)...`);
        yield* Effect.sleep(`${drainMs} millis`);

        yield* Effect.logInfo('Phase 3: shutting down servers...');
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) =>
              httpServer.close(() => {
                resolve();
              }),
            ),
        );
        yield* Effect.promise(() => server.shutdown());
        yield* Effect.logInfo('HTTP + gRPC servers stopped');
      }).pipe(Effect.annotateLogs('module', 'Shutdown')),
    );

    // Block forever
    yield* Effect.never;
  }).pipe(Effect.annotateLogs('module', 'Bootstrap'), Effect.scoped, Effect.provide(appLive as any));

  BunRuntime.runMain(program as any, { disablePrettyLogger: true });
}
