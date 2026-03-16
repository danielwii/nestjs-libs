/**
 * Embedding Types - 向量嵌入模型的类型定义和阈值配置
 *
 * 本文件包含：
 * - 模型选型指南（定价、能力、适用场景）
 * - 模型感知的相似度阈值配置（基于校准测试）
 * - Embedding 模型的元数据定义
 */

// ═══════════════════════════════════════════════════════════════════════════
// 模型选型指南（2026-03 更新）
// ═══════════════════════════════════════════════════════════════════════════
//
// ## ⚠️ 切换模型 = 全量 re-embed
//
// 不同模型的向量空间不兼容，切换意味着：
// 1. 所有历史数据重新 embed（item_embeddings + rag_chunks）
// 2. 向量库索引重建
// 3. 阈值重新校准（不同模型相似度分布差异巨大）
//
// ## 模型对比
//
// | 模型                      | 维度   | 价格/M  | 上下文  | Task Type | 适用场景 |
// |---------------------------|--------|---------|---------|-----------|----------|
// | Jina v5-text-nano ✅       | 1024d  | $0.02   | 32K     | ✅ LoRA   | 最优性价比，质量第2 |
// | Jina v5-text-small        | 1024d  | $0.045  | 32K     | ✅ LoRA   | 质量最高（Gap 9.6%） |
// | OpenAI v3-small           | 1536d  | $0.02   | 8K      | ❌        | 低成本原型 |
// | OpenAI v3-large           | 3072d  | $0.13   | 8K      | ❌        | 精度较高 |
// | Voyage 3-large            | 1024d  | $0.06   | 8K      | ❌        | 区分度差（Gap -1.0%） |
// | Voyage 3.5-lite           | 1024d  | $0.02   | 8K      | ❌        | 区分度最差（Gap -5.3%） |
// | Jina v4                   | 可调   | 免费    | 32K     | ✅ LoRA   | 多模态，不可商用（Qwen 许可） |
// | Gemini embedding-001      | 3072d  | $0.15   | 2K      | ✅        | 区分度极差（Gap 9.6%），不推荐 |
// | Gemini embedding-2        | 3072d  | $0.20   | 8K      | ✅        | 多模态，区分度极差（Gap 7.3%） |
//
// ## Task Type（LoRA Adapter）效果验证
//
// Ablation study (v5-small, 38 对真实数据):
//   baseline (no task): Discrimination  3.6%
//   recall (query+passage): Discrimination  9.6% (+6.0%)
// 结论：LoRA task adapter 显著提升区分度，UNRELATED 平均下降 28%
//
// ## 推荐
//
// - 纯文本 RAG 最优性价比：Jina v5-text-nano（$0.02/M，32K ctx，LoRA，Gap 9.1%）
// - 纯文本 RAG 质量最高：Jina v5-text-small（$0.045/M，Gap 9.6%）
// - 多模态搜索：Gemini embedding-2（$0.20/M，唯一支持 video/audio，但区分度差）
//
// ═══════════════════════════════════════════════════════════════════════════
// 校准阈值（2026-03-14，38 对真实场景数据，recall scenario: query+passage）
// ═══════════════════════════════════════════════════════════════════════════
//
// | 模型                  | DUPLICATE   | SIMILAR     | UNRELATED   | 区分度 |
// |-----------------------|-------------|-------------|-------------|--------|
// | Jina v5-small ⭐       | 87-96%      | 46-78%      | -1-36%      |  9.6%  |
// | Jina v5-nano ⭐        | 86-97%      | 46-80%      |  0-37%      |  9.1%  |
// | OpenAI large          | 95-99%      | 39-76%      |  5-35%      |  4.6%  |
// | OpenAI small          | 95-99%      | 45-72%      |  3-41%      |  3.9%  |
// | Voyage 3-large        | 97-100%     | 56-88%      | 23-57%      | -1.0%  |
// | Voyage 3.5-lite       | 86-99%      | 42-75%      | 15-47%      | -5.3%  |
//
// 区分度 = SIMILAR.min - UNRELATED.max，越高越好。
// Jina v5 是唯一区分度显著 >0 的模型，得益于 LoRA task adapter。
//
// 阈值算法：取相邻类别边界中点
// - DUPLICATE = (max_similar + min_duplicate) / 2
// - RELEVANCE = (max_unrelated + min_similar) / 2
// - DUPLICATE 使用 dedup 场景（text-matching task），RELEVANCE 使用 recall 场景
//
// @see https://community.openai.com/t/rule-of-thumb-cosine-similarity-thresholds/693670
// @see https://github.com/microsoft/kernel-memory/discussions/542
//
// ═══════════════════════════════════════════════════════════════════════════

/** 阈值配置接口 */
export interface EmbeddingThresholdConfig {
  /** 完全重复阈值（跳过）：高于此值视为重复 */
  duplicate: number;
  /** 语义相关阈值：高于此值认为语义相关（用于召回、合并判断） */
  relevance: number;
}

/** 模型提供商 */
export type EmbeddingProvider = 'openai' | 'jina' | 'voyage' | 'gemini';

/** OpenAI Embedding 模型 */
export type OpenAIEmbeddingModel = 'text-embedding-3-small' | 'text-embedding-3-large' | 'text-embedding-ada-002';

/** Jina Embedding 模型 */
export type JinaEmbeddingModel = 'jina-embeddings-v5-text-small' | 'jina-embeddings-v5-text-nano';

/** Voyage Embedding 模型 */
export type VoyageEmbeddingModel = 'voyage-3.5-lite' | 'voyage-3-large';

/** Gemini Embedding 模型 */
export type GeminiEmbeddingModel = 'gemini-embedding-001' | 'gemini-embedding-2-preview';

/** 所有支持的 Embedding 模型 */
export type EmbeddingModel = OpenAIEmbeddingModel | JinaEmbeddingModel | VoyageEmbeddingModel | GeminiEmbeddingModel;

/**
 * Embedding Model Key（provider:model 格式，与 LLMModelKey 统一设计）
 *
 * @example
 * 'openai:text-embedding-3-small'
 * 'jina:jina-embeddings-v5-text'
 * 'gemini:gemini-embedding-2-preview'
 */
export type EmbeddingModelKey =
  | `openai:${OpenAIEmbeddingModel}`
  | `jina:${JinaEmbeddingModel}`
  | `voyage:${VoyageEmbeddingModel}`
  | `gemini:${GeminiEmbeddingModel}`;

/** Task Type 支持 */
export type EmbeddingTaskType =
  | 'retrieval.query'
  | 'retrieval.passage'
  | 'text-matching'
  | 'classification'
  | 'separation'
  | 'clustering'
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | 'CODE_RETRIEVAL_QUERY';

/** Embedding 模型元数据 */
export interface EmbeddingModelMetadata {
  /** 模型 ID */
  id: EmbeddingModel;
  /** 提供商 */
  provider: EmbeddingProvider;
  /** 向量维度（默认输出，部分模型支持 Matryoshka 可调） */
  dimensions: number;
  /** 价格（$/1M tokens） */
  pricePerMillion: number;
  /** 最大输入 token 数 */
  maxInputTokens: number;
  /** 阈值配置 */
  thresholds: EmbeddingThresholdConfig;
  /** 支持的 task types（空数组 = 不支持） */
  taskTypes: EmbeddingTaskType[];
  /** 支持的模态 */
  modalities: ('text' | 'image' | 'video' | 'audio' | 'pdf')[];
  /** 是否已弃用 */
  deprecated?: boolean;
}

/**
 * 各模型的校准阈值
 *
 * ## 使用场景
 *
 * | 阈值 | 用途 | 示例 |
 * |------|------|------|
 * | duplicate | 跳过重复内容 | Items 合并时，高于此值直接跳过 |
 * | relevance | 语义相关判断 | 记忆召回、相似搜索、内容合并候选 |
 *
 * ## ⚠️ 重要提醒
 *
 * **不同模型的相似度分数范围差异巨大，不能使用统一阈值！**
 *
 * | 模型 | "相关"分数范围 | 推荐阈值 | 说明 |
 * |------|---------------|----------|------|
 * | text-embedding-ada-002 | 0.70-0.85 | 0.75-0.79 | 旧模型，分数较高 |
 * | text-embedding-3-small | 0.37-0.56 | **0.38** | 校准：SIMILAR 最低 37.1%，0.3 会误召回表面相关 |
 * | text-embedding-3-large | 0.27-0.50 | **0.25-0.35** | 更大模型，分数更低 |
 */
export const EMBEDDING_MODEL_THRESHOLDS: Record<EmbeddingModel, EmbeddingThresholdConfig> = {
  // OpenAI 模型
  'text-embedding-3-small': { duplicate: 0.77, relevance: 0.38 },
  'text-embedding-3-large': { duplicate: 0.78, relevance: 0.35 },
  'text-embedding-ada-002': { duplicate: 0.9, relevance: 0.75 }, // 旧模型，分数较高
  // Jina 模型
  // Voyage 模型
  'voyage-3.5-lite': { duplicate: 0.83, relevance: 0.46 },
  'voyage-3-large': { duplicate: 0.88, relevance: 0.55 },
  // Jina v5-text-small（2026-03-14 校准，38 对真实场景数据）
  // recall (query+passage): SIM 46-78% | UNR -1-36% | Gap 9.6%
  // dedup  (text-matching): DUP 87-96%
  // duplicate = dedup 场景 DUP 中点，relevance = recall 场景 (UNR.max + SIM.min) / 2
  'jina-embeddings-v5-text-small': { duplicate: 0.93, relevance: 0.41 },
  // Jina v5-text-nano（2026-03-14 校准，38 对真实场景数据）
  // recall (query+passage): SIM 46-80% | UNR 0-37% | Gap 9.1%
  // dedup  (text-matching): DUP 86-97%
  'jina-embeddings-v5-text-nano': { duplicate: 0.93, relevance: 0.41 },
  // Gemini（待校准）
  'gemini-embedding-001': { duplicate: 0.78, relevance: 0.35 },
  'gemini-embedding-2-preview': { duplicate: 0.78, relevance: 0.35 },
};

/** 默认使用的模型 */
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = 'text-embedding-3-small';

/** 默认阈值配置 */
export const DEFAULT_EMBEDDING_THRESHOLDS: EmbeddingThresholdConfig =
  EMBEDDING_MODEL_THRESHOLDS[DEFAULT_EMBEDDING_MODEL];

/**
 * 获取指定模型的阈值配置
 *
 * @param model 模型名称（如 'text-embedding-3-small'）
 * @returns 阈值配置
 *
 * @example
 * ```typescript
 * import { getEmbeddingThresholds } from '@app/llm-core';
 *
 * // 获取当前模型的阈值
 * const thresholds = getEmbeddingThresholds('text-embedding-3-small');
 * console.log(thresholds.relevance); // 0.30
 *
 * // 用于记忆召回
 * if (similarity >= thresholds.relevance) {
 *   // 语义相关，纳入候选
 * }
 * ```
 */
export function getEmbeddingThresholds(model?: EmbeddingModel | EmbeddingModelKey | string): EmbeddingThresholdConfig {
  if (!model) return DEFAULT_EMBEDDING_THRESHOLDS;

  // 支持 'provider:model' 格式（如 'jina:jina-embeddings-v5-text-small'），自动提取 model 部分
  const parts = model.split(':');
  const modelId = parts.length > 1 ? (parts.at(1) ?? model) : model;

  if (modelId in EMBEDDING_MODEL_THRESHOLDS) {
    return EMBEDDING_MODEL_THRESHOLDS[modelId as EmbeddingModel];
  }
  return DEFAULT_EMBEDDING_THRESHOLDS;
}

/**
 * 所有 Embedding 模型的元数据
 *
 * 包含维度、价格、阈值等完整信息
 */
export const EMBEDDING_MODELS: Record<EmbeddingModel, EmbeddingModelMetadata> = {
  // ── OpenAI ──
  'text-embedding-3-small': {
    id: 'text-embedding-3-small',
    provider: 'openai',
    dimensions: 1536,
    pricePerMillion: 0.02,
    maxInputTokens: 8192,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['text-embedding-3-small'],
    taskTypes: [],
    modalities: ['text'],
  },
  'text-embedding-3-large': {
    id: 'text-embedding-3-large',
    provider: 'openai',
    dimensions: 3072,
    pricePerMillion: 0.13,
    maxInputTokens: 8192,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['text-embedding-3-large'],
    taskTypes: [],
    modalities: ['text'],
  },
  'text-embedding-ada-002': {
    id: 'text-embedding-ada-002',
    provider: 'openai',
    dimensions: 1536,
    pricePerMillion: 0.1,
    maxInputTokens: 8192,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['text-embedding-ada-002'],
    taskTypes: [],
    modalities: ['text'],
    deprecated: true,
  },
  // ── Jina ──
  'jina-embeddings-v5-text-small': {
    id: 'jina-embeddings-v5-text-small',
    provider: 'jina',
    dimensions: 1024, // Matryoshka 可调，677M 参数
    pricePerMillion: 0.045,
    maxInputTokens: 32768,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['jina-embeddings-v5-text-small'],
    taskTypes: ['retrieval.query', 'retrieval.passage', 'text-matching', 'classification', 'clustering'],
    modalities: ['text'],
  },
  'jina-embeddings-v5-text-nano': {
    id: 'jina-embeddings-v5-text-nano',
    provider: 'jina',
    dimensions: 768, // Matryoshka 可调（32-768），239M 参数
    pricePerMillion: 0.02, // 比 small 便宜
    maxInputTokens: 32768,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['jina-embeddings-v5-text-nano'],
    taskTypes: ['retrieval.query', 'retrieval.passage', 'text-matching', 'classification', 'clustering'],
    modalities: ['text'],
  },
  // ── Voyage ──
  'voyage-3.5-lite': {
    id: 'voyage-3.5-lite',
    provider: 'voyage',
    dimensions: 1024,
    pricePerMillion: 0.02,
    maxInputTokens: 8192,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['voyage-3.5-lite'],
    taskTypes: [],
    modalities: ['text'],
  },
  'voyage-3-large': {
    id: 'voyage-3-large',
    provider: 'voyage',
    dimensions: 1024,
    pricePerMillion: 0.06,
    maxInputTokens: 8192,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['voyage-3-large'],
    taskTypes: [],
    modalities: ['text'],
  },
  // ── Gemini ──
  'gemini-embedding-001': {
    id: 'gemini-embedding-001',
    provider: 'gemini',
    dimensions: 3072, // Matryoshka, 可调 128-3072
    pricePerMillion: 0.15,
    maxInputTokens: 2048,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['gemini-embedding-001'],
    taskTypes: [
      'RETRIEVAL_QUERY',
      'RETRIEVAL_DOCUMENT',
      'SEMANTIC_SIMILARITY',
      'CLASSIFICATION',
      'CLUSTERING',
      'CODE_RETRIEVAL_QUERY',
    ],
    modalities: ['text'],
  },
  'gemini-embedding-2-preview': {
    id: 'gemini-embedding-2-preview',
    provider: 'gemini',
    dimensions: 3072, // Matryoshka, 可调 128-3072
    pricePerMillion: 0.2,
    maxInputTokens: 8192,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['gemini-embedding-2-preview'],
    taskTypes: [
      'RETRIEVAL_QUERY',
      'RETRIEVAL_DOCUMENT',
      'SEMANTIC_SIMILARITY',
      'CLASSIFICATION',
      'CLUSTERING',
      'CODE_RETRIEVAL_QUERY',
    ],
    modalities: ['text', 'image', 'video', 'audio', 'pdf'],
  },
};
