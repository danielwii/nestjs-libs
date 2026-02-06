/**
 * Embedding Types - 向量嵌入模型的类型定义和阈值配置
 *
 * 本文件包含：
 * - 模型感知的相似度阈值配置（基于校准测试）
 * - Embedding 模型的元数据定义
 */

// ═══════════════════════════════════════════════════════════════════════════
// 模型感知阈值配置（基于校准测试 2025-01-03）
// ═══════════════════════════════════════════════════════════════════════════
//
// 校准命令：使用本地评估脚本（此处不固定具体项目命令）
//
// ## 校准结果（16 对测试数据）
//
// | 模型                  | 维度   | 价格/M  | DUPLICATE | SIMILAR     | UNRELATED   | 区分度 |
// |-----------------------|--------|---------|-----------|-------------|-------------|--------|
// | OpenAI small          | 1536d  | $0.02   | 97-100%   | 37-56%      | 6-22%       | 14.9%  |
// | OpenAI large ⭐        | 3072d  | $0.13   | 96-100%   | 51-59%      | 5-18%       | 33.1%  |
// | Jina v3               | 1024d  | $0.02   | 99-100%   | 66-77%      | 31-44%      | 21.7%  |
// | Voyage 3.5-lite       | 1024d  | $0.02   | 95-100%   | 54-72%      | 22-39%      | 15.6%  |
// | Voyage 3-large        | 1024d  | $0.06   | 94-100%   | 70-81%      | 30-41%      | 28.9%  |
//
// ## 区分度排名（越高越好，SIMILAR.min - UNRELATED.max）
//
// 1. OpenAI large (33.1%) - 最清晰边界，追求精度首选
// 2. Voyage 3-large (28.9%) - 次优，价格只有 OpenAI large 一半
// 3. Jina v3 (21.7%) - 低成本选择
// 4. Voyage 3.5-lite (15.6%)
// 5. OpenAI small (14.9%)
//
// ## 关键发现
//
// 1. **不同模型差异巨大**：Jina/Voyage SIMILAR 范围（65-81%）远高于 OpenAI（37-59%）
// 2. **必须模型感知**：硬编码阈值在切换模型时会完全失效
// 3. **性价比推荐**：
//    - 追求精度：OpenAI large（$0.13/M，区分度 33.1%）
//    - 平衡选择：Voyage 3-large（$0.06/M，区分度 28.9%）
//    - 低成本：Jina v3（$0.02/M，区分度 21.7%）
//
// ## 阈值算法
//
// 取相邻类别边界的中点：
// - DUPLICATE = (max_similar + min_duplicate) / 2
// - MERGE = (max_unrelated + min_similar) / 2
//
// ## 外部参考资料
//
// @see https://community.openai.com/t/rule-of-thumb-cosine-similarity-thresholds/693670
// @see https://github.com/microsoft/kernel-memory/discussions/542
// @see https://www.datacamp.com/tutorial/open-ai-similarity-embedding
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
export type EmbeddingProvider = 'openai' | 'jina' | 'voyage';

/** OpenAI Embedding 模型 */
export type OpenAIEmbeddingModel = 'text-embedding-3-small' | 'text-embedding-3-large' | 'text-embedding-ada-002';

/** Jina Embedding 模型 */
export type JinaEmbeddingModel = 'jina-embeddings-v3';

/** Voyage Embedding 模型 */
export type VoyageEmbeddingModel = 'voyage-3.5-lite' | 'voyage-3-large';

/** 所有支持的 Embedding 模型 */
export type EmbeddingModel = OpenAIEmbeddingModel | JinaEmbeddingModel | VoyageEmbeddingModel;

/**
 * Embedding Model Key（provider:model 格式，与 LLMModelKey 统一设计）
 *
 * @example
 * 'openai:text-embedding-3-small'
 * 'jina:jina-embeddings-v3'
 * 'voyage:voyage-3-large'
 */
export type EmbeddingModelKey =
  | `openai:${OpenAIEmbeddingModel}`
  | `jina:${JinaEmbeddingModel}`
  | `voyage:${VoyageEmbeddingModel}`;

/** Embedding 模型元数据 */
export interface EmbeddingModelMetadata {
  /** 模型 ID */
  id: EmbeddingModel;
  /** 提供商 */
  provider: EmbeddingProvider;
  /** 向量维度 */
  dimensions: number;
  /** 价格（$/1M tokens） */
  pricePerMillion: number;
  /** 阈值配置 */
  thresholds: EmbeddingThresholdConfig;
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
 * | text-embedding-3-small | 0.30-0.55 | **0.30** | 新模型，分数较低 |
 * | text-embedding-3-large | 0.27-0.50 | **0.25-0.35** | 更大模型，分数更低 |
 */
export const EMBEDDING_MODEL_THRESHOLDS: Record<EmbeddingModel, EmbeddingThresholdConfig> = {
  // OpenAI 模型
  'text-embedding-3-small': { duplicate: 0.77, relevance: 0.3 },
  'text-embedding-3-large': { duplicate: 0.78, relevance: 0.35 },
  'text-embedding-ada-002': { duplicate: 0.9, relevance: 0.75 }, // 旧模型，分数较高
  // Jina 模型
  'jina-embeddings-v3': { duplicate: 0.88, relevance: 0.55 },
  // Voyage 模型
  'voyage-3.5-lite': { duplicate: 0.83, relevance: 0.46 },
  'voyage-3-large': { duplicate: 0.88, relevance: 0.55 },
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
export function getEmbeddingThresholds(model?: EmbeddingModel | string): EmbeddingThresholdConfig {
  if (!model) return DEFAULT_EMBEDDING_THRESHOLDS;
  if (model in EMBEDDING_MODEL_THRESHOLDS) {
    return EMBEDDING_MODEL_THRESHOLDS[model as EmbeddingModel];
  }
  return DEFAULT_EMBEDDING_THRESHOLDS;
}

/**
 * 所有 Embedding 模型的元数据
 *
 * 包含维度、价格、阈值等完整信息
 */
export const EMBEDDING_MODELS: Record<EmbeddingModel, EmbeddingModelMetadata> = {
  'text-embedding-3-small': {
    id: 'text-embedding-3-small',
    provider: 'openai',
    dimensions: 1536,
    pricePerMillion: 0.02,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['text-embedding-3-small'],
  },
  'text-embedding-3-large': {
    id: 'text-embedding-3-large',
    provider: 'openai',
    dimensions: 3072,
    pricePerMillion: 0.13,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['text-embedding-3-large'],
  },
  'text-embedding-ada-002': {
    id: 'text-embedding-ada-002',
    provider: 'openai',
    dimensions: 1536,
    pricePerMillion: 0.1,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['text-embedding-ada-002'],
    deprecated: true,
  },
  'jina-embeddings-v3': {
    id: 'jina-embeddings-v3',
    provider: 'jina',
    dimensions: 1024,
    pricePerMillion: 0.02,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['jina-embeddings-v3'],
  },
  'voyage-3.5-lite': {
    id: 'voyage-3.5-lite',
    provider: 'voyage',
    dimensions: 1024,
    pricePerMillion: 0.02,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['voyage-3.5-lite'],
  },
  'voyage-3-large': {
    id: 'voyage-3-large',
    provider: 'voyage',
    dimensions: 1024,
    pricePerMillion: 0.06,
    thresholds: EMBEDDING_MODEL_THRESHOLDS['voyage-3-large'],
  },
};
