/**
 * Context Slot — 通用上下文工程核心类型
 *
 * 领域无关，0 外部依赖。任何 LLM Agent 项目都能用。
 */

// ═══════════════════════════════════════════════════════════════════════════
// ContextSlot<T> — 类型安全槽位
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 上下文槽位定义。
 *
 * T 从 renderers 函数签名自动推导，调用方无需手动传泛型。
 * renderers 的 key 是 fidelity 标识（如 'full' | 'compact'），
 * value 是渲染函数，返回 null 表示条件跳过。
 */
export interface ContextSlot<T = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly priority: number;
  /** fidelity key → 渲染函数。返回 null = 条件跳过 */
  readonly renderers: Partial<Record<string, (data: T) => string | null>>;
  /** 可选元数据：数据变化频率 */
  readonly volatility?: 'static' | 'session' | 'turn';
}

/**
 * 类型安全工厂。
 *
 * 运行时是 identity 函数，价值在于让 T 从 renderers 自动推导。
 * 参数直接复用 ContextSlot<T>（结构一致，无需独立参数类型）。
 */
export function defineSlot<T>(def: ContextSlot<T>): ContextSlot<T> {
  return def;
}

// ═══════════════════════════════════════════════════════════════════════════
// CompileOptions — 编译选项
// ═══════════════════════════════════════════════════════════════════════════

export interface CompileOptions {
  /** 渲染精度：选择哪个 renderer */
  readonly fidelity: string;
  /** 最低优先级阈值（低于此值的 slot 跳过） */
  readonly minPriority?: number;
  /** 最大 slot 数量（超出时按 priority 裁剪） */
  readonly maxSlots?: number;
  /** 最大 token 预算（超出时按 priority 贪心裁剪） */
  readonly maxTokens?: number;
  /** 自定义 token 估算器（默认 chars/2） */
  readonly tokenEstimator?: (text: string) => number;
  /** 只包含指定分类 */
  readonly categories?: readonly string[];
  /** 排除指定 slot ID */
  readonly exclude?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CompiledBlock — 编译输出
// ═══════════════════════════════════════════════════════════════════════════

export interface CompiledBlock {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number;
  readonly category: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Inspection / Description 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface BagInspection {
  readonly filledSlots: readonly string[];
  /** 注册了但未 fill 的 slot（仅 catalog.createBag() 创建的 bag 有值） */
  readonly unfilledSlots: readonly string[];
  readonly categoryCounts: Readonly<Record<string, number>>;
}

export interface CatalogDescription {
  readonly totalSlots: number;
  readonly categories: Readonly<Record<string, readonly string[]>>;
  readonly slots: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly category: string;
    readonly priority: number;
    readonly fidelities: readonly string[];
    readonly volatility?: 'static' | 'session' | 'turn';
  }>;
}
