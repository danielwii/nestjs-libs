/**
 * Context Slots — 通用上下文工程核心库
 *
 * 0 外部依赖，可直接挪到 nestjs-libs。
 */

export {
  defineSlot,
  type BagInspection,
  type CatalogDescription,
  type CompileOptions,
  type CompiledBlock,
  type ContextSlot,
} from './context-slot.types';

export { ContextBag } from './context-bag';
export { SlotCatalog } from './slot-catalog';
