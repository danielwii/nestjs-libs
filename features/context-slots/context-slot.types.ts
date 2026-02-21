/**
 * Context Slot — 通用上下文工程核心类型
 *
 * 领域无关，0 外部依赖。任何 LLM Agent 项目都能用。
 */

/** 渲染函数签名 */
export type Renderer<T> = (data: T, options: CompileOptions) => string | null;

// ═══════════════════════════════════════════════════════════════════════════
// 三层架构：State + Strategy + Tools
// ═══════════════════════════════════════════════════════════════════════════

/** 编译层 */
export type ContextLayer = 'state' | 'strategy';

/** Tool 参数（JSON Schema 子集，0 依赖） */
export interface SlotToolParam {
  readonly type: 'string' | 'number' | 'boolean';
  readonly description: string;
  readonly enum?: readonly string[];
}

/** Tool 规格（框架层，不含 execute） */
export interface SlotToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, SlotToolParam>>;
  readonly required?: readonly string[];
}

/** collectTools 输出（附加来源 slot） */
export interface CollectedTool extends SlotToolSpec {
  readonly slotId: string;
}

/** collectTools 过滤选项 */
export interface CollectToolsOptions {
  readonly categories?: readonly string[];
  readonly exclude?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// ContextSlot<T> — 类型安全槽位
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 上下文槽位定义。
 *
 * T 从 renderers 函数签名自动推导，调用方无需手动传泛型。
 * renderers 的 key 是 fidelity 标识（如 'full' | 'compact'）。
 *
 * ## 激活函数模式 (Activation Function Pattern)
 *
 * 渲染函数接收 (data, options)：
 * 1. **激活自律**：函数内部可访问 options（如 currentTurn, maxTokens），返回 null 表示在当前语境下「隐藏」。
 * 2. **动态渲染**：内容可随 options 变化（如根据剩余预算返回不同长度的文本）。
 */
export interface ContextSlot<T = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly priority: number;
  /**
   * Layer 1: State — fidelity key → 渲染函数。
   * @param data 槽位持有的业务数据
   * @param options 编译时的全局选项（用于实现动态激活逻辑）
   * @returns 渲染出的字符串，返回 null 表示在当前语境下跳过此槽位
   */
  readonly renderers: Partial<Record<string, Renderer<T>>>;
  /**
   * Layer 2: Strategy — 行动指南（与 renderers 同 fidelity key + 同 Renderer 签名）。
   * 描述 Agent 在此状态下可采取的行为指南。
   */
  readonly strategies?: Partial<Record<string, Renderer<T>>>;
  /**
   * Layer 3: Tools — 状态驱动的动态工具。
   * 根据 data 动态决定提供哪些工具（如情绪偏差大时才提供 adjust_emotion）。
   */
  readonly tools?: (data: T, options: CompileOptions) => SlotToolSpec[];
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
  /** 编译哪些层（默认 ['state']） */
  readonly layers?: readonly ContextLayer[];
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
  /** 行动指南（仅 layers 含 'strategy' 且 slot 有 strategy renderer 时有值） */
  readonly strategy?: string;
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

// ═══════════════════════════════════════════════════════════════════════════
// LayoutConfig — 后编译排列配置
// ═══════════════════════════════════════════════════════════════════════════

/**
 * U 型布局配置。
 *
 * head 区的 slot 固定在最前，tail 区的 slot 固定在最后，
 * 其余进入 middle 区按 priority 降序排列。
 */
export interface LayoutConfig {
  readonly head: readonly string[];
  readonly tail: readonly string[];
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
