/**
 * ContextRecipe — 上下文组装规范
 *
 * ## 设计理念
 *
 * ContextSlot 框架治理了 3 件事：定义（Slot catalog）、渲染（renderers）、编译（compile）。
 * Recipe 补全了第 4 件：**组装**（assembly）— 每个模式 fill 哪些 slot、用什么 preset/layout。
 *
 * "知道上下文怎么组装" 和 "知道有什么上下文" 同样重要。
 *
 * ## 设计原则
 *
 * - **声明式**：Recipe 是纯数据，不控制运行时行为
 * - **不抽象 fill**：数据来源是 orchestrator/service 的职责，Recipe 只声明"结果应该是什么样"
 * - **验证在测试中**：生产环境不强制验证（不增加运行时开销）
 * - **Additive**：现有 fill 站点代码不需要修改
 *
 * ## 使用模式
 *
 * ```typescript
 * // 声明 recipe
 * const MY_RECIPE: ContextRecipe = {
 *   id: 'my-mode',
 *   name: '我的模式',
 *   description: '...',
 *   slots: {
 *     required: [SlotA, SlotB],  // 必须 fill
 *     optional: [SlotC, SlotD],  // 条件 fill（未 fill 正常）
 *   },
 *   preset: { fidelity: 'full' },
 * };
 *
 * // 测试中验证
 * const result = validateRecipe(bag, MY_RECIPE);
 * expect(result.valid).toBe(true);
 * ```
 *
 * ## Builder 消费方式
 *
 * Builder 从 RECIPES 获取 preset 和 layout（single source of truth），
 * 不在 Builder 中维护本地副本：
 *
 * ```typescript
 * // ✅ 从 RECIPES 获取
 * compileRecipe(bag, RECIPES.MESSAGE_STANDARD);
 * bag.compile(RECIPES.VOICE_CHAT.preset);
 *
 * // ❌ 硬编码 preset/layout
 * bag.compile({ fidelity: 'full' });
 * ```
 */

import type { ContextBag } from './context-bag';
import type { CompiledBlock, CompileOptions, ContextLayer, ContextSlot, LayoutConfig } from './context-slot.types';

// ═══════════════════════════════════════════════════════════════════════════
// ContextRecipe
// ═══════════════════════════════════════════════════════════════════════════

export interface ContextRecipe {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 期望的 slot 集合 */
  readonly slots: {
    /** 必须 fill 的 slot（未 fill → 验证警告） */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly required: ReadonlyArray<ContextSlot<any>>;
    /** 条件 fill 的 slot（未 fill 是正常的） */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly optional: ReadonlyArray<ContextSlot<any>>;
  };
  /** 编译选项 */
  readonly preset: CompileOptions;
  /** 可选的后编译排列策略（U 型布局） */
  readonly layout?: LayoutConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// RecipeValidation
// ═══════════════════════════════════════════════════════════════════════════

export interface RecipeValidation {
  /** true = 无 missing required 且无 unexpected */
  readonly valid: boolean;
  /** required slot 未 fill */
  readonly missingRequired: readonly string[];
  /** 不在 required/optional 中但被 fill 了 */
  readonly unexpected: readonly string[];
  /** 已 fill 的 slot 占 (required + optional) 的比例 */
  readonly coverage: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// RecipeCatalogDescription
// ═══════════════════════════════════════════════════════════════════════════

export interface RecipeCatalogDescription {
  readonly totalRecipes: number;
  readonly recipes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly requiredSlots: readonly string[];
    readonly optionalSlots: readonly string[];
    readonly preset: CompileOptions;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// validateRecipe
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 验证 bag 是否符合 recipe 规范。
 *
 * 用 recipe 声明的 slot 集合作为参照（不依赖 catalog）。
 * 适用于任何 ContextBag（不要求 catalog.createBag()）。
 */
export function validateRecipe(bag: ContextBag, recipe: ContextRecipe): RecipeValidation {
  const { required: requiredSlots, optional: optionalSlots } = recipe.slots;

  const expectedIds = new Set([...requiredSlots.map((s) => s.id), ...optionalSlots.map((s) => s.id)]);

  // missing: required but not filled
  const missingRequired = requiredSlots.filter((s) => !bag.has(s)).map((s) => s.id);

  // unexpected: filled but not in expected set
  const { filledSlots } = bag.inspect();
  const unexpected = filledSlots.filter((id) => !expectedIds.has(id));

  const totalExpected = requiredSlots.length + optionalSlots.length;
  const coverage = totalExpected > 0 ? filledSlots.filter((id) => expectedIds.has(id)).length / totalExpected : 1;

  return {
    valid: missingRequired.length === 0 && unexpected.length === 0,
    missingRequired,
    unexpected,
    coverage,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// uShapedLayout — 后编译排列
// ═══════════════════════════════════════════════════════════════════════════

/**
 * U 型重排：head 区 → middle 区（按 priority 降序）→ tail 区。
 *
 * - head/tail 中不存在的 id 自动跳过
 * - 不在 head/tail 中的 block 进入 middle，按 priority 降序排列
 */
export function uShapedLayout(blocks: readonly CompiledBlock[], config: LayoutConfig): CompiledBlock[] {
  const headIds = new Set(config.head);
  const tailIds = new Set(config.tail);

  const blockMap = new Map(blocks.map((b) => [b.id, b]));

  const headBlocks = config.head.map((id) => blockMap.get(id)).filter((b): b is CompiledBlock => b !== undefined);

  const tailBlocks = config.tail.map((id) => blockMap.get(id)).filter((b): b is CompiledBlock => b !== undefined);

  const middleBlocks = blocks
    .filter((b) => !headIds.has(b.id) && !tailIds.has(b.id))
    .sort((a, b) => b.priority - a.priority);

  return [...headBlocks, ...middleBlocks, ...tailBlocks];
}

// ═══════════════════════════════════════════════════════════════════════════
// CompileOverrides — 编译覆盖选项
// ═══════════════════════════════════════════════════════════════════════════

export interface CompileOverrides {
  readonly layers?: readonly ContextLayer[];
}

// ═══════════════════════════════════════════════════════════════════════════
// compileRecipe — 编译 + 布局一步完成
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 编译 + 布局一步完成。
 *
 * 等价于 `bag.compile(recipe.preset)` + 可选 `uShapedLayout(blocks, recipe.layout)`。
 * Builder 消费 RECIPES 的推荐入口。
 *
 * @param overrides 可选覆盖选项（如 layers: ['state', 'strategy']）
 */
export function compileRecipe(bag: ContextBag, recipe: ContextRecipe, overrides?: CompileOverrides): CompiledBlock[] {
  const preset = overrides?.layers ? { ...recipe.preset, layers: overrides.layers } : recipe.preset;
  const blocks = bag.compile(preset);
  if (recipe.layout) {
    return uShapedLayout(blocks, recipe.layout);
  }
  return blocks;
}
