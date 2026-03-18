/**
 * Health Indicator — Port 定义
 *
 * DDD 分层：Port（接口层）
 * 各 Adapter（Redis、Prisma）实现 HealthIndicator 并注册到 HealthRegistry。
 *
 * K8s 三层探针：
 * - liveness:  进程活着（无需 indicator）
 * - readiness: 自身依赖（DB、Redis），失败 → K8s 摘流量
 * - topology:  下游服务可达性，失败 → 告警
 */

import { Effect } from 'effect';

export type HealthIndicatorType = 'readiness' | 'topology';

export interface HealthIndicatorResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly latencyMs?: number;
  readonly error?: string;
}

/** Effect-native health indicator — check 返回 Effect 而非 Promise */
export interface HealthIndicator {
  readonly type: HealthIndicatorType;
  readonly check: () => Effect.Effect<HealthIndicatorResult>;
}

// ==================== Factory Functions ====================

const TIMEOUT_MS = 2000;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** DB readiness indicator: SELECT 1 with 2s timeout */
export function createDbHealthIndicator(queryFn: () => Promise<unknown>): HealthIndicator {
  return {
    type: 'readiness',
    check: () =>
      Effect.gen(function* () {
        const start = Date.now();
        return yield* Effect.tryPromise(() => queryFn()).pipe(
          Effect.timeout(`${TIMEOUT_MS} millis`),
          Effect.map(() => ({ name: 'database' as const, healthy: true, latencyMs: Date.now() - start })),
          Effect.catchAll((e) =>
            Effect.succeed({
              name: 'database' as const,
              healthy: false,
              latencyMs: Date.now() - start,
              error: errorMessage(e),
            }),
          ),
        );
      }),
  };
}

/** Redis readiness indicator: PING with 2s timeout */
export function createRedisHealthIndicator(pingFn: () => Promise<string>): HealthIndicator {
  return {
    type: 'readiness',
    check: () =>
      Effect.gen(function* () {
        const start = Date.now();
        return yield* Effect.tryPromise(() => pingFn()).pipe(
          Effect.timeout(`${TIMEOUT_MS} millis`),
          Effect.map((r) => ({ name: 'redis' as const, healthy: r === 'PONG', latencyMs: Date.now() - start })),
          Effect.catchAll((e) =>
            Effect.succeed({
              name: 'redis' as const,
              healthy: false,
              latencyMs: Date.now() - start,
              error: errorMessage(e),
            }),
          ),
        );
      }),
  };
}
