/**
 * Health Registry — DI 中心
 *
 * DDD 分层：Application Service（编排层）
 *
 * Effect DI 模式：
 * - HealthRegistry 是 Context.Tag（Port）
 * - HealthRegistryLive 是 Layer（Adapter）
 * - Addon 通过 Layer.tap 在构建时注册 indicator
 *
 * 与 NestJS 版对比：
 * - NestJS: @Injectable() class + constructor DI + onModuleInit 注册
 * - Effect: Context.Tag + Ref + Layer.tap 注册（编译期类型安全）
 *
 * @example
 * ```ts
 * // addon 注册（在 Layer 构建时）
 * const PrismaLive = Layer.scoped(PrismaTag, ...).pipe(
 *   Layer.tap(() =>
 *     Effect.flatMap(HealthRegistry, (registry) =>
 *       registry.register(createDbHealthIndicator(() => prisma.$queryRawUnsafe('SELECT 1'))),
 *     ),
 *   ),
 * );
 *
 * // health endpoint 读取
 * const checks = yield* Effect.flatMap(HealthRegistry, (r) => r.checkAll('readiness'));
 * ```
 */

import { Context, Effect, Layer, Ref } from 'effect';

import type { HealthIndicator, HealthIndicatorResult, HealthIndicatorType } from './indicator';

// ==================== Service Interface ====================

export interface HealthRegistryService {
  /** 注册一个 health indicator */
  readonly register: (indicator: HealthIndicator) => Effect.Effect<void>;
  /** 获取指定类型的所有 indicators */
  readonly getByType: (type: HealthIndicatorType) => Effect.Effect<ReadonlyArray<HealthIndicator>>;
  /** 执行指定类型的所有检查 */
  readonly checkAll: (type: HealthIndicatorType) => Effect.Effect<ReadonlyArray<HealthIndicatorResult>>;
}

// ==================== Tag (Port) ====================

export class HealthRegistry extends Context.Tag('HealthRegistry')<HealthRegistry, HealthRegistryService>() {}

// ==================== Layer (Adapter) ====================

/** HealthRegistry 实现：Ref 管理可变注册表 */
export const HealthRegistryLive: Layer.Layer<HealthRegistry> = Layer.effect(
  HealthRegistry,
  Effect.gen(function* () {
    const indicatorsRef = yield* Ref.make<ReadonlyArray<HealthIndicator>>([]);

    const service: HealthRegistryService = {
      register: (indicator) => Ref.update(indicatorsRef, (list) => [...list, indicator]),

      getByType: (type) => Ref.get(indicatorsRef).pipe(Effect.map((list) => list.filter((i) => i.type === type))),

      checkAll: (type) =>
        Effect.gen(function* () {
          const indicators = yield* service.getByType(type);
          if (indicators.length === 0) return [];
          return yield* Effect.promise(() => Promise.all(indicators.map((i) => i.check())));
        }),
    };

    return service;
  }),
);
