/**
 * Health Registry — DI 中心
 *
 * DDD 分层：Application Service（编排层）
 *
 * Effect DI 模式：
 * - HealthRegistry 是 Effect.Service（Tag + Default Layer 一体）
 * - accessors: true 允许 HealthRegistry.register(indicator) 直接调用
 * - Addon 通过 Layer.tap 在构建时注册 indicator
 *
 * 与 NestJS 版对比：
 * - NestJS: @Injectable() class + constructor DI + onModuleInit 注册
 * - Effect: Effect.Service + Ref + Layer.tap 注册（编译期类型安全）
 *
 * @example
 * ```ts
 * // addon 注册（在 Layer 构建时）— 使用 accessors
 * yield* HealthRegistry.register(createDbHealthIndicator(() => prisma.$queryRawUnsafe('SELECT 1')));
 *
 * // health endpoint 读取
 * const checks = yield* HealthRegistry.checkAll('readiness');
 * ```
 */

import { Effect, Ref } from 'effect';

import type { HealthIndicator, HealthIndicatorResult, HealthIndicatorType } from './indicator';

// ==================== Service Interface ====================

export interface HealthRegistryService {
  /** 注册一个 health indicator */
  readonly register: (indicator: HealthIndicator) => Effect.Effect<void>;
  /** 获取指定类型的所有 indicators */
  readonly getByType: (type: HealthIndicatorType) => Effect.Effect<ReadonlyArray<HealthIndicator>>;
  /** 执行指定类型的所有检查 */
  readonly checkAll: (type: HealthIndicatorType) => Effect.Effect<ReadonlyArray<HealthIndicatorResult>>;
  /** 标记为正在关闭（readiness 探针返回 not_ready，K8s 摘流量） */
  readonly markShuttingDown: () => Effect.Effect<void>;
  /** 是否正在关闭 */
  readonly isShuttingDown: () => Effect.Effect<boolean>;
}

// ==================== Service (Tag + Default Layer) ====================

export class HealthRegistry extends Effect.Service<HealthRegistry>()('HealthRegistry', {
  accessors: true,
  effect: Effect.gen(function* () {
    const indicatorsRef = yield* Ref.make<ReadonlyArray<HealthIndicator>>([]);
    const shuttingDownRef = yield* Ref.make(false);

    return {
      register: (indicator: HealthIndicator) => Ref.update(indicatorsRef, (list) => [...list, indicator]),

      getByType: (type: HealthIndicatorType) =>
        Ref.get(indicatorsRef).pipe(Effect.map((list) => list.filter((i) => i.type === type))),

      checkAll: (type: HealthIndicatorType) =>
        Effect.gen(function* () {
          const indicators = yield* Ref.get(indicatorsRef).pipe(
            Effect.map((list) => list.filter((i) => i.type === type)),
          );
          if (indicators.length === 0) return [];
          return yield* Effect.all(
            indicators.map((i) =>
              i.check().pipe(
                // check() 内部已 catchAll，但防御未知 defect — 降级为 unhealthy 结果
                Effect.catchAllDefect((e) =>
                  Effect.succeed({
                    name: 'unknown',
                    healthy: false,
                    error: e instanceof Error ? e.message : String(e),
                  } satisfies HealthIndicatorResult),
                ),
              ),
            ),
            { concurrency: 'unbounded' },
          );
        }),

      markShuttingDown: () => Ref.set(shuttingDownRef, true),

      isShuttingDown: () => Ref.get(shuttingDownRef),
    } satisfies HealthRegistryService;
  }),
}) {}
