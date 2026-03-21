/**
 * Health HTTP API — 通用 schema + handler
 *
 * 所有 Effect 项目共用，不需要项目级定制。
 *
 * 三层 K8s 探针：
 * - GET /health          — liveness（进程活着）
 * - GET /health/ready    — readiness（DB/Redis + shutdown 状态）
 * - GET /health/topology — 下游服务可达性
 *
 * @example
 * ```ts
 * // api.ts
 * import { HealthGroup } from '@app/effect/http/health';
 * export class Api extends HttpApi.make('api').add(HealthGroup) {}
 *
 * // interface/health.ts
 * import { healthHandlers } from '@app/effect/http/health';
 * export const HealthGroupLive = HttpApiBuilder.group(Api, 'health', healthHandlers);
 * ```
 */

import { HealthRegistry } from '../health';

import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import { Duration, Effect, Schema } from 'effect';

import type { HealthIndicatorResult } from '../health';

// ==================== Schema（API 契约） ====================

const HealthCheckResult = Schema.Struct({
  name: Schema.String,
  healthy: Schema.Boolean,
  latencyMs: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});

/** Health API group schema — 添加到项目 Api：`HttpApi.make('api').add(HealthGroup)` */
export class HealthGroup extends HttpApiGroup.make('health')
  .add(
    HttpApiEndpoint.get('check', '/health').addSuccess(
      Schema.Struct({ status: Schema.String, timestamp: Schema.String }),
    ),
  )
  .add(
    HttpApiEndpoint.get('ready', '/health/ready').addSuccess(
      Schema.Struct({
        status: Schema.String,
        checks: Schema.Record({ key: Schema.String, value: HealthCheckResult }),
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get('topology', '/health/topology').addSuccess(
      Schema.Struct({
        status: Schema.String,
        checks: Schema.Record({ key: Schema.String, value: HealthCheckResult }),
        error: Schema.optional(Schema.String),
      }),
    ),
  ) {}

// ==================== Handler ====================

/**
 * Health endpoint handlers — 传给 `HttpApiBuilder.group(Api, 'health', healthHandlers)`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HttpApiBuilder.group handler 类型过于复杂
export const healthHandlers = (handlers: any) =>
  handlers
    .handle('check', () => Effect.succeed({ status: 'ok' as const, timestamp: new Date().toISOString() }))
    .handle('ready', () =>
      Effect.gen(function* () {
        const registry = yield* HealthRegistry;

        const shuttingDown = yield* registry.isShuttingDown();
        if (shuttingDown) {
          return { status: 'not_ready' as const, checks: {} as Record<string, HealthIndicatorResult> };
        }

        const checks = yield* registry.checkAll('readiness');
        const allHealthy = checks.length === 0 || checks.every((c) => c.healthy);
        return {
          status: allHealthy ? ('ready' as const) : ('not_ready' as const),
          checks: Object.fromEntries(checks.map((c) => [c.name, c])) as Record<string, HealthIndicatorResult>,
        };
      }),
    )
    .handle('topology', () =>
      Effect.gen(function* () {
        const registry = yield* HealthRegistry;
        const indicators = yield* registry.getByType('topology');

        if (indicators.length === 0) {
          return { status: 'ok' as const, checks: {} as Record<string, HealthIndicatorResult> };
        }

        const results = yield* Effect.all(
          indicators.map((i) => i.check()),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.catchAll(() => Effect.succeed([] as HealthIndicatorResult[])),
          Effect.map((r) => r),
        );

        if (results.length === 0) {
          return { status: 'down' as const, checks: {} as Record<string, HealthIndicatorResult> };
        }

        const checks = Object.fromEntries(results.map((c) => [c.name, c])) as Record<string, HealthIndicatorResult>;
        const healthyCount = results.filter((r) => r.healthy).length;

        if (healthyCount === results.length) {
          return { status: 'ok' as const, checks };
        }

        const status = healthyCount === 0 ? ('down' as const) : ('degraded' as const);
        return { status, checks };
      }),
    );
