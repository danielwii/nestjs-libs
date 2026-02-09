/**
 * 预配置 LLM 客户端单例
 *
 * 设计意图：
 * - 零配置使用，apiKey 和 proxy 全部从 SysEnv 读取
 * - 懒加载，首次使用时才初始化
 * - 直接导出可用的 provider 函数
 *
 * ## 模型选型指南（2026-01）
 *
 * | 场景 | 推荐模型 | 理由 |
 * |------|---------|------|
 * | generateObject 批量输出 | `google('gemini-2.5-flash')` | 原生支持 structured output，thinking tokens 免费 |
 * | 多轮工具编排 | `openrouter('x-ai/grok-4.1-fast')` | 性价比高 $0.20/$0.50/M，2M ctx，tool calling 准确 |
 * | 复杂推理 | `google('gemini-2.5-pro')` | 推理能力强，thinking tokens 免费 |
 * | 大上下文 | `openrouter('x-ai/grok-4.1-fast')` | 2M context window |
 *
 * ## 价格参考（2026-01）
 *
 * | 模型 | Input | Output | 备注 |
 * |------|-------|--------|------|
 * | gemini-2.5-flash | $0.15/M | $0.60/M | thinking tokens 免费 |
 * | gemini-2.5-pro | $1.25/M | $10/M | thinking tokens 免费 |
 * | grok-4.1-fast | $0.20/M | $0.50/M | 2M ctx，性价比之选 |
 * | claude-4-sonnet | $3/M | $15/M | 编码/Agent 能力强 |
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

import { SysEnv, SysProxy } from '@app/env';
import { ApiFetcher } from '@app/utils/fetch';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { LanguageModel } from 'ai';

// ============================================================================
// 单例缓存
// ============================================================================

let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _vertex: ReturnType<typeof createVertex> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;

// ============================================================================
// OpenRouter 客户端
// ============================================================================

/**
 * 获取 OpenRouter 客户端单例
 *
 * 自动使用：
 * - SysEnv.OPENROUTER_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
function getOpenRouter() {
  if (!_openrouter) {
    if (!SysEnv.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is not configured in SysEnv');
    }
    _openrouter = createOpenRouter({
      apiKey: SysEnv.OPENROUTER_API_KEY,
      fetch: ApiFetcher.fetch,
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
 * openrouter('openai/grok-4.1-fast')
 * ```
 */
export const openrouter = (modelId: string): LanguageModel => getOpenRouter()(modelId);

/**
 * OpenRouter 默认 providerOptions（禁用 reasoning/thinking）
 *
 * 默认禁用 reasoning 以节省成本。如需启用，使用 autoOpts.thinking()。
 *
 * @example
 * ```typescript
 * import { openrouter, OPENROUTER_DEFAULTS } from '@app/features/llm';
 *
 * await generateText({
 *   model: openrouter('x-ai/grok-4.1-fast'),
 *   providerOptions: OPENROUTER_DEFAULTS,
 *   // ...
 * });
 * ```
 */
export const OPENROUTER_DEFAULTS = {
  openrouter: { reasoning: { effort: 'none' as const } },
};

// ============================================================================
// Google AI 客户端
// ============================================================================

/**
 * 获取 Google AI 客户端单例
 *
 * 自动使用：
 * - SysEnv.GOOGLE_GENERATIVE_AI_API_KEY
 * - ApiFetcher.fetch（带代理）
 */
function getGoogle() {
  if (!_google) {
    if (!SysEnv.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured in SysEnv');
    }
    _google = createGoogleGenerativeAI({
      apiKey: SysEnv.GOOGLE_GENERATIVE_AI_API_KEY,
      fetch: ApiFetcher.fetch,
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
// Vertex AI 客户端 (Express Mode)
// ============================================================================

/**
 * 获取 Vertex AI 客户端单例 (Express Mode)
 *
 * 自动使用：
 * - SysEnv.GOOGLE_VERTEX_API_KEY
 * - Express Mode（无需 project/location）
 */
function getVertex() {
  if (!_vertex) {
    if (!SysEnv.GOOGLE_VERTEX_API_KEY) {
      throw new Error('GOOGLE_VERTEX_API_KEY is not configured in SysEnv');
    }
    _vertex = createVertex({
      apiKey: SysEnv.GOOGLE_VERTEX_API_KEY,
    });
  }
  return _vertex;
}

/**
 * Vertex AI 模型选择器 (Express Mode)
 *
 * @example
 * ```typescript
 * vertex('gemini-2.5-flash')
 * vertex('gemini-2.5-pro')
 * ```
 */
export const vertex = (modelId: string): LanguageModel => getVertex()(modelId);

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
    vertex: {
      configured: !!SysEnv.GOOGLE_VERTEX_API_KEY,
      initialized: !!_vertex,
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
  _vertex = null;
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
 * - ApiFetcher.fetch（带代理）
 */
export function getOpenAI() {
  if (!_openai) {
    if (!SysEnv.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured in SysEnv');
    }
    _openai = createOpenAI({
      apiKey: SysEnv.OPENAI_API_KEY,
      fetch: ApiFetcher.fetch,
    });
  }
  return _openai;
}
