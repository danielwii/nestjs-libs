/**
 * Context Projection — 声明式 Slot 填充
 *
 * ## 设计动机
 *
 * Builder 中的 `bag.fill()` 调用是命令式代码，无法程序化校验完整性。
 * Projection 将 "source → slot" 映射声明为数据（数组），实现：
 *
 * 1. **可校验**：测试可断言 "recipe 中每个 slot 要么有 projection 要么在手动白名单中"
 * 2. **类型安全**：`forSource<T>().project(slot, fn)` 强制 fn 返回与 slot 数据类型匹配的值
 * 3. **co-location**：projection 与 slot 定义放在同一目录，新增 slot 时一起改
 *
 * ## 使用模式
 *
 * ```typescript
 * const hb = forSource<HeartbeatContext>();
 * const PROJECTIONS = [
 *   hb.project(MySlot, (ctx) => ctx.someField ?? null),
 * ] as const;
 *
 * // Builder 中
 * applyProjections(bag, ctx, PROJECTIONS);
 * ```
 *
 * ## null 语义
 *
 * extract 返回 null/undefined → 跳过该 slot（不填入 bag）。
 * 等价于 `if (data != null) bag.fill(slot, data)`。
 */

import type { ContextBag } from './context-bag';
import type { ContextSlot } from './context-slot.types';

/**
 * 单个 slot 的投影声明：从 TSource 提取 TData 填入 slot。
 */
export interface SlotProjection<TSource, TData> {
  readonly slot: ContextSlot<TData>;
  readonly extract: (source: TSource) => TData | null | undefined;
}

/**
 * 创建绑定到特定 source 类型的投影工厂。
 *
 * 类型推导链：`forSource<Ctx>().project(SlotWithDataType, fn)`
 * → TypeScript 推导 fn 必须返回 `DataType | null | undefined`
 * → 返回类型不匹配 = 编译报错
 */
export function forSource<TSource>() {
  return {
    project<TData>(
      slot: ContextSlot<TData>,
      extract: (source: TSource) => TData | null | undefined,
    ): SlotProjection<TSource, TData> {
      return { slot, extract };
    },
  };
}

/**
 * 批量执行投影：遍历声明数组，extract → null 检查 → bag.fill。
 *
 * @returns 实际填入的 slot 数量（用于调试日志）
 */
export function applyProjections<TSource>(
  bag: ContextBag,
  source: TSource,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 异构泛型 slot 数组
  projections: readonly SlotProjection<TSource, any>[],
): number {
  let filled = 0;
  for (const { slot, extract } of projections) {
    const data = extract(source);
    if (data != null) {
      bag.fill(slot, data);
      filled++;
    }
  }
  return filled;
}
