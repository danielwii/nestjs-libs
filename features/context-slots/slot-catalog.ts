/**
 * SlotCatalog — 全局注册表
 *
 * "系统知道自己知道什么" — 所有上下文注册到 catalog = 全貌可见 = 对抗熵增。
 */

import { ContextBag } from './context-bag';

import type { ContextRecipe, RecipeCatalogDescription } from './context-recipe';
import type { CatalogDescription, ContextSlot } from './context-slot.types';

export class SlotCatalog {
  private readonly slots = new Map<string, ContextSlot>();
  private readonly recipes: ContextRecipe[] = [];

  register<T>(slot: ContextSlot<T>): void {
    if (this.slots.has(slot.id)) {
      throw new Error(`SlotCatalog: duplicate slot id "${slot.id}"`);
    }
    this.slots.set(slot.id, slot as ContextSlot);
  }

  get(id: string): ContextSlot | undefined {
    return this.slots.get(id);
  }

  list(): ContextSlot[] {
    return [...this.slots.values()];
  }

  listByCategory(category: string): ContextSlot[] {
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
