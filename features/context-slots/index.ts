/**
 * Context Slots — 通用上下文工程核心库
 *
 * 0 外部依赖，可直接挪到 nestjs-libs。
 */

export {
  defineSlot,
  resolveSlotRef,
  type BagInspection,
  type CatalogDescription,
  type CollectedTool,
  type CollectToolsOptions,
  type CompileOptions,
  type CompiledBlock,
  type ContextLayer,
  type ContextSlot,
  type LayoutConfig,
  type Renderer,
  type SlotRef,
  type SlotToolParam,
  type SlotToolSpec,
} from './context-slot.types';

export { ContextBag } from './context-bag';
export { SlotCatalog } from './slot-catalog';
export {
  compileRecipe,
  uShapedLayout,
  validateRecipe,
  type CompileOverrides,
  type ContextRecipe,
  type RecipeCatalogDescription,
  type RecipeValidation,
} from './context-recipe';
export { applyProjections, forSource, type SlotProjection } from './context-projection';
