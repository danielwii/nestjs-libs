/**
 * SlotCatalog — 全局注册表
 *
 * "系统知道自己知道什么" — 所有上下文注册到 catalog = 全貌可见 = 对抗熵增。
 */

import { ContextBag } from './context-bag';

import type { ContextRecipe, RecipeCatalogDescription } from './context-recipe';
import type { CatalogDescription, ContextSlot } from './context-slot.types';

export class SlotCatalog {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly slots = new Map<string, ContextSlot<any, any>>();
  private readonly recipes: ContextRecipe[] = [];

  /**
   * 从 recipe 声明自动构建 catalog（Single Source of Truth）。
   *
   * 设计动机：手动 register() + registerRecipe() 存在同步 bug —
   * 新增 slot 到 recipe 但忘了 register → registerRecipe 校验抛异常（或更糟：没测试覆盖时静默遗漏）。
   * fromRecipes 让 recipe 成为唯一声明源，catalog 自动派生。
   *
   * @param recipes  要注册的 recipe 列表
   * @param extras   不在任何 recipe 中但需要注册的 slot（如动态注入的 WebPerceptionSlot）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromRecipes(recipes: readonly ContextRecipe[], extras?: readonly ContextSlot<any, any>[]): SlotCatalog {
    const catalog = new SlotCatalog();
    const seen = new Set<string>();

    // 1. 收集所有 recipe 引用的 slot（去重）
    for (const recipe of recipes) {
      for (const slot of [...recipe.slots.required, ...recipe.slots.optional]) {
        if (!seen.has(slot.id)) {
          seen.add(slot.id);
          catalog.register(slot);
        }
      }
    }

    // 2. 注册 extras（不在 recipe 中的独立 slot）
    if (extras) {
      for (const slot of extras) {
        if (!seen.has(slot.id)) {
          seen.add(slot.id);
          catalog.register(slot);
        }
      }
    }

    // 3. 注册 recipe（此时所有引用的 slot 已存在，registerRecipe 校验必过）
    for (const recipe of recipes) {
      catalog.registerRecipe(recipe);
    }

    return catalog;
  }

  register<T, K extends string>(slot: ContextSlot<T, K>): void {
    if (this.slots.has(slot.id)) {
      throw new Error(`SlotCatalog: duplicate slot id "${slot.id}"`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.slots.set(slot.id, slot as ContextSlot<any, any>);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(id: string): ContextSlot<any, any> | undefined {
    return this.slots.get(id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): ContextSlot<any, any>[] {
    return [...this.slots.values()];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listByCategory(category: string): ContextSlot<any, any>[] {
    return [...this.slots.values()].filter((s) => s.category === category);
  }

  /** 自描述：输出所有 slot 的元信息（调试/文档用） */
  describe(): CatalogDescription {
    const categories: Record<string, string[]> = {};

    for (const slot of this.slots.values()) {
      const cat = categories[slot.category];
      if (cat) {
        cat.push(slot.id);
      } else {
        categories[slot.category] = [slot.id];
      }
    }

    const slots = [...this.slots.values()].map((slot) => ({
      id: slot.id,
      title: slot.title,
      description: slot.description,
      category: slot.category,
      priority: slot.priority,
      fidelities: Object.keys(slot.renderers),
      volatility: slot.volatility,
    }));

    return {
      totalSlots: this.slots.size,
      categories,
      slots,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Recipe 管理
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 注册 recipe。
   *
   * 验证 recipe 中引用的 slot 是否都已注册到 catalog（开发时保护）。
   */
  registerRecipe(recipe: ContextRecipe): void {
    if (this.recipes.some((r) => r.id === recipe.id)) {
      throw new Error(`SlotCatalog: duplicate recipe id "${recipe.id}"`);
    }
    for (const slot of [...recipe.slots.required, ...recipe.slots.optional]) {
      if (!this.get(slot.id)) {
        throw new Error(`Recipe "${recipe.id}" references unregistered slot "${slot.id}"`);
      }
    }
    this.recipes.push(recipe);
  }

  listRecipes(): ContextRecipe[] {
    return [...this.recipes];
  }

  /** 输出所有 recipe 的结构化描述 */
  describeRecipes(): RecipeCatalogDescription {
    return {
      totalRecipes: this.recipes.length,
      recipes: this.recipes.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        requiredSlots: r.slots.required.map((s) => s.id),
        optionalSlots: r.slots.optional.map((s) => s.id),
        preset: r.preset,
      })),
    };
  }

  /**
   * 创建 ContextBag，包含所有已注册 slot 的引用。
   * inspect() 可以列出"注册了但未 fill"的 slot。
   */
  createBag(): ContextBag {
    return new ContextBag(new Set(this.slots.keys()));
  }
}
