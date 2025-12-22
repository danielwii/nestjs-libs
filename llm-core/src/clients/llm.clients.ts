/**
 * 预配置 LLM 客户端单例
 *
 * 设计意图：
 * - 零配置使用，apiKey 和 proxy 全部从 SysEnv 读取
 * - 懒加载，首次使用时才初始化
 * - 直接导出可用的 provider 函数
 *
 * @example
 * ```typescript
 * import { openrouter, google } from '@app/llm-core';
 * import { streamText, generateObject } from 'ai';
 *
 * // 直接使用，无需任何配置
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 * });
 *
 * await generateObject({
 *   model: google('gemini-2.5-flash'),
 *   schema: MySchema,
 *   messages: [...],
 * });
 * ```
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { embed } from 'ai';
import { SysEnv, SysProxy } from '@app/env';
import { ApiFetcher } from '@app/utils';
import type { LanguageModel } from 'ai';

// ============================================================================
// 单例缓存
// ============================================================================

let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;

// ============================================================================
// OpenRouter 客户端
// ============================================================================

/**
 * 获取 OpenRouter 客户端单例
 *
 * 自动使用：
 * - SysEnv.OPENROUTER_API_KEY
 * - ApiFetcher.undiciFetch（带代理）
 */
function getOpenRouter() {
  if (!_openrouter) {
    if (!SysEnv.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is not configured in SysEnv');
    }
    _openrouter = createOpenRouter({
      apiKey: SysEnv.OPENROUTER_API_KEY,
      fetch: ApiFetcher.undiciFetch,
    });
  }
  return _openrouter;
}

/**
 * OpenRouter 模型选择器
 *
 * @example
 * ```typescript
 * openrouter('google/gemini-2.5-flash')
 * openrouter('anthropic/claude-3.5-sonnet')
 * openrouter('openai/gpt-4o')
 * ```
 */
export const openrouter = (modelId: string): LanguageModel => getOpenRouter()(modelId);

// ============================================================================
// Google AI 客户端
// ============================================================================

/**
 * 获取 Google AI 客户端单例
 *
 * 自动使用：
 * - SysEnv.GOOGLE_GENERATIVE_AI_API_KEY
 * - ApiFetcher.undiciFetch（带代理）
 */
function getGoogle() {
  if (!_google) {
    if (!SysEnv.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured in SysEnv');
    }
    _google = createGoogleGenerativeAI({
      apiKey: SysEnv.GOOGLE_GENERATIVE_AI_API_KEY,
      fetch: ApiFetcher.undiciFetch,
    });
  }
  return _google;
}

/**
 * Google AI 模型选择器
 *
 * @example
 * ```typescript
 * google('gemini-2.5-flash')
 * google('gemini-2.5-pro')
 * google('gemini-2.5-flash-thinking')
 * ```
 */
export const google = (modelId: string): LanguageModel => getGoogle()(modelId);

// ============================================================================
// 客户端状态检查
// ============================================================================

/**
 * 检查 LLM 客户端配置状态
 */
export function getLLMClientStatus() {
  return {
    openrouter: {
      configured: !!SysEnv.OPENROUTER_API_KEY,
      initialized: !!_openrouter,
    },
    google: {
      configured: !!SysEnv.GOOGLE_GENERATIVE_AI_API_KEY,
      initialized: !!_google,
    },
    proxy: {
      enabled: SysEnv.APP_PROXY_ENABLED ?? false,
      host: SysProxy.proxy || null,
    },
  };
}

/**
 * 重置客户端（测试用）
 */
export function resetLLMClients() {
  _openrouter = null;
  _google = null;
  _openai = null;
}

// ============================================================================
// OpenAI 客户端（用于 Embedding）
// ============================================================================

/**
 * 获取 OpenAI 客户端单例
 *
 * 自动使用：
 * - SysEnv.OPENAI_API_KEY
 * - ApiFetcher.undiciFetch（带代理）
 */
function getOpenAI() {
  if (!_openai) {
    if (!SysEnv.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured in SysEnv');
    }
    _openai = createOpenAI({
      apiKey: SysEnv.OPENAI_API_KEY,
      fetch: ApiFetcher.undiciFetch,
    });
  }
  return _openai;
}

// ============================================================================
// Embedding 函数
// ============================================================================

/** Embedding 模型类型 */
export type EmbeddingModel = 'text-embedding-3-small' | 'text-embedding-3-large';

/**
 * 生成文本的 Embedding 向量
 *
 * 使用 OpenAI 的 embedding 模型：
 * - text-embedding-3-small: 1536 维，性价比高（默认）
 * - text-embedding-3-large: 3072 维，更高精度
 *
 * @example
 * ```typescript
 * import { embedding } from '@app/llm-core';
 *
 * // 默认使用 text-embedding-3-small (1536 维)
 * const vector = await embedding('some text');
 *
 * // 使用更高精度模型 (3072 维)
 * const vector = await embedding('some text', 'text-embedding-3-large');
 * ```
 */
export async function embedding(
  text: string,
  model: EmbeddingModel = 'text-embedding-3-small',
): Promise<number[]> {
  const openai = getOpenAI();
  const embeddingModel = openai.textEmbeddingModel(model);
  const result = await embed({ model: embeddingModel, value: text });
  return result.embedding;
}
