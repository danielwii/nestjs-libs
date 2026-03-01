/**
 * ContextBag — 类型安全上下文容器
 *
 * fill 顺序保留（Map 插入顺序），compile 不排序。
 * 排列策略由领域层（LayoutStrategy）决定。
 *
 * ## 当前模式：Builder 手动分发
 *
 * Builder 从共享数据源（如 HeartbeatContext）手动拆包，逐个 fill 到各 slot。
 * Slot 越多，Builder 的 fillBag() 越长 — 这是 slot 自治的代价。
 *
 * ## 未来方向：声明式投影（Projection）
 *
 * Slot 声明依赖（needs: ['emotion', 'time']），ContextBag 从注册的数据源自动投射。
 * Builder 退化为"数据源注册器"（bag.provide(ctx)），不再手动拆包。
 * 核心挑战：投影的类型安全（声明的 name → 数据类型映射）。
 */

import type {
  BagInspection,
  CollectedTool,
  CollectToolsOptions,
  CompiledBlock,
  CompileOptions,
  ContextSlot,
} from './context-slot.types';

/**
 * 内部存储条目。
 *
 * ── 类型擦除点 ──
 * slot 存为 ContextSlot<any, any>（故意的类型擦除，T + K 都擦除）。
 * 安全不变量：同一 id 的 slot 和 data 始终配对（fill 是唯一写入路径）。
 */
interface Entry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly slot: ContextSlot<any, any>;
  readonly data: unknown;
}

const DEFAULT_TOKEN_ESTIMATOR = (text: string): number => Math.ceil(text.length / 2);

export class ContextBag {
  /**
   * 单一 Map，利用 Map 插入顺序 = fill 顺序。
   * 重复 fill 同一 slot：Map.set 更新 value 但不改变 key 的插入位置（ES2015 规范）。
   */
  private readonly entries = new Map<string, Entry>();

  /** catalog 中所有已注册的 slot id（仅 createBag() 创建时传入） */
  private readonly registeredSlotIds: ReadonlySet<string>;

  constructor(registeredSlotIds?: ReadonlySet<string>) {
    this.registeredSlotIds = registeredSlotIds ?? new Set();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 读写
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 类型安全填充。
   *
   * 重复 fill 同一个 slot：覆盖 data，保留原始 fill 位置。
   * fill 是唯一写入路径 — 保证 slot.renderers 和 data 的类型始终匹配。
   *
   * 注意：直接引用 slot 常量来 fill（如 `bag.fill(EmotionSlot, data)`），
   * 不要从 catalog.get() 取出后 fill，否则会丢失泛型信息。
   */
  fill<T>(slot: ContextSlot<T>, data: T): this {
    // Cast 点 1: ContextSlot<T, K> → ContextSlot<any, any>（故意的类型擦除）
    // 安全因为同 id 的 data 由同一次 fill 提供
    this.entries.set(slot.id, { slot, data });
    return this;
  }

  /** 类型安全读取 */
  get<T>(slot: ContextSlot<T>): T | undefined {
    const entry = this.entries.get(slot.id);
    if (!entry) return undefined;
    // Cast 点 2: unknown → T（从 entries Map 取出）
    // 安全因为 fill 是唯一写入路径
    return entry.data as T;
  }

  /** 检查是否已填充（只需要 id，避免泛型协变问题） */
  has(slot: Pick<ContextSlot, 'id'>): boolean {
    return this.entries.has(slot.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 编译
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 编译所有已填充的 slot。
   *
   * ## 输出顺序
   * 最终输出按 fill 顺序。maxSlots/maxTokens 只决定"保留哪些 slot"
   * （用 priority 选择），不改变输出顺序。
   *
   * ## 处理流程
   * filled slots (fill 顺序)
   *   → filter: minPriority / categories / exclude
   *   → render: 取 fidelity 对应 renderer，跳过不存在的
   *   → filter: renderer 返回 null 或 trim() 为空 → 跳过
   *   → truncate (如指定): maxSlots / maxTokens
   *   → 输出: CompiledBlock[] (fill 顺序)
   */
  compile(options: CompileOptions): CompiledBlock[] {
    const { fidelity, minPriority, maxSlots, maxTokens, categories, exclude, layers } = options;
    const tokenEstimator = options.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR;
    const categorySet = categories ? new Set(categories) : undefined;
    const excludeSet = exclude ? new Set(exclude) : undefined;
    const includeStrategy = layers?.includes('strategy') ?? false;

    // Phase 1: filter + render state（保持 fill 顺序）
    const rendered: CompiledBlock[] = [];

    for (const { slot, data } of this.entries.values()) {
      // filter: minPriority
      if (minPriority !== undefined && slot.priority < minPriority) continue;
      // filter: categories
      if (categorySet && !categorySet.has(slot.category)) continue;
      // filter: exclude
      if (excludeSet?.has(slot.id)) continue;

      // render: 取 fidelity 对应 renderer，fallback 到 'full'
      const renderer = slot.renderers[fidelity] ?? slot.renderers['full'];
      if (!renderer) continue;

      // render + filter: null 或空字符串跳过
      const content = renderer(data, options);
      if (content === null || content.trim() === '') continue;

      // Phase 3.5: render strategy（仅 layers 含 'strategy' 时），fallback 到 'full'
      let strategy: string | undefined;
      if (includeStrategy && slot.strategies) {
        const strategyRenderer = slot.strategies[fidelity] ?? slot.strategies['full'];
        if (strategyRenderer) {
          const strategyText = strategyRenderer(data, options);
          if (strategyText !== null && strategyText.trim() !== '') {
            strategy = strategyText;
          }
        }
      }

      rendered.push({
        id: slot.id,
        title: slot.title,
        content,
        priority: slot.priority,
        category: slot.category,
        ...(strategy !== undefined && { strategy }),
      });
    }

    // Phase 2: truncate（如指定）— token 估算包含 state + strategy
    if (maxSlots !== undefined && rendered.length > maxSlots) {
      return this.truncateBySlots(rendered, maxSlots);
    }

    if (maxTokens !== undefined) {
      return this.truncateByTokens(rendered, maxTokens, tokenEstimator);
    }

    return rendered;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tools 收集
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 从已 fill 的 slot 收集动态 tools。
   *
   * 遍历 entries，调用 slot.tools(data, ...)，附加 slotId 后扁平返回。
   */
  collectTools(options?: CollectToolsOptions): CollectedTool[] {
    const categorySet = options?.categories ? new Set(options.categories) : undefined;
    const excludeSet = options?.exclude ? new Set(options.exclude) : undefined;
    const collected: CollectedTool[] = [];

    for (const { slot, data } of this.entries.values()) {
      if (!slot.tools) continue;
      if (categorySet && !categorySet.has(slot.category)) continue;
      if (excludeSet?.has(slot.id)) continue;

      const specs = slot.tools(data, { fidelity: 'full' });
      for (const spec of specs) {
        collected.push({ ...spec, slotId: slot.id });
      }
    }

    return collected;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 自检
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 自检：列出已填充和未填充的 slot。
   *
   * "未填充"需要 catalog 引用：createBag() 时传入注册表。
   * 直接 new ContextBag() 创建的 bag 只能列出已填充的 slot。
   */
  inspect(): BagInspection {
    const filledSlots: string[] = [];
    const categoryCounts: Record<string, number> = {};

    for (const { slot } of this.entries.values()) {
      filledSlots.push(slot.id);
      categoryCounts[slot.category] = (categoryCounts[slot.category] ?? 0) + 1;
    }

    const unfilledSlots = [...this.registeredSlotIds].filter((id) => !this.entries.has(id));

    return { filledSlots, unfilledSlots, categoryCounts };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 内部：裁剪
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 按 priority 选出 keeper set，保持 fill 顺序输出。
   * 同 priority 按 fill 顺序 tie-break（靠前的优先保留）。
   */
  private truncateBySlots(blocks: CompiledBlock[], maxSlots: number): CompiledBlock[] {
    if (maxSlots <= 0) return [];

    // 按 priority 降序 + fill 顺序 tie-break 选出 keeper
    const indexed = blocks.map((b, i) => ({ block: b, fillIndex: i }));
    indexed.sort((a, b) => b.block.priority - a.block.priority || a.fillIndex - b.fillIndex);

    const keeperIds = new Set(indexed.slice(0, maxSlots).map((item) => item.block.id));

    // 按 fill 顺序输出
    return blocks.filter((b) => keeperIds.has(b.id));
  }

  /**
   * 按 priority 贪心选择 slot，直到 token 预算用完。
   * 同 priority 按 fill 顺序 tie-break。
   * 所有 slot 单个都超预算 → 返回空数组（不破坏预算承诺）。
   */
  private truncateByTokens(
    blocks: CompiledBlock[],
    maxTokens: number,
    estimator: (text: string) => number,
  ): CompiledBlock[] {
    if (maxTokens <= 0) return [];

    // 按 priority 降序 + fill 顺序 tie-break
    const indexed = blocks.map((b, i) => ({ block: b, fillIndex: i }));
    indexed.sort((a, b) => b.block.priority - a.block.priority || a.fillIndex - b.fillIndex);

    const keeperIds = new Set<string>();
    let remaining = maxTokens;

    for (const { block } of indexed) {
      const tokens = estimator(block.content) + (block.strategy ? estimator(block.strategy) : 0);
      if (tokens <= remaining) {
        keeperIds.add(block.id);
        remaining -= tokens;
      }
    }

    // 按 fill 顺序输出
    return blocks.filter((b) => keeperIds.has(b.id));
  }
}
