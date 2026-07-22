/**
 * 自动路由 LLM 客户端
 *
 * 根据 Model Key 自动选择正确的 Provider 客户端
 *
 * @example
 * ```typescript
 * import { autoOpts, model } from '@app/llm-core';
 * import { streamText } from 'ai';
 *
 * // 自动路由到 OpenRouter
 * await streamText({
 *   model: model('openrouter:gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: autoOpts.noThinking('openrouter:gemini-2.5-flash'),
 * });
 *
 * // 自动路由到 Google
 * await streamText({
 *   model: model('google:gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: autoOpts.noThinking('google:gemini-2.5-flash'),
 * });
 * ```
 */
import { Oops } from '@app/nest/exceptions/oops';

import { getModel, isModelRegistered, parseModelSpec, resolveThinkingForModel } from '../types/model.types';
import { bedrockThinkingOptions } from './bedrock.client';
import { bedrock, google, openrouter, vertex, vertexGlobal } from './llm.clients';
import { disableThinkingOptions, reasoningEffortOptions } from './options.helpers';

import '@app/nest/exceptions/oops-factories';

import { getAppLogger } from '@app/utils/app-logger';

import type { LLMModelKey, LLMModelSpec, LLMProviderType } from '../types/model.types';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { LanguageModel } from 'ai';

const autoOptsLogger = getAppLogger('features', 'LLM', 'autoOpts');

/**
 * 完整 model key 必须通过 registry contract 生成 options；裸 provider 名只保留旧的
 * provider-level 行为，无法判断 mandatory reasoning 或 Google thinking mode。
 */
function resolveAutoOptsModelContract(key: LLMModelKey | string) {
  if (!key.includes(':')) return undefined;
  const parsed = parseModelSpec(key as LLMModelSpec);
  if (!isModelRegistered(parsed.key)) return undefined;
  return { key: parsed.key, config: getModel(parsed.key) };
}

/**
 * autoOpts 的 Bedrock 分支需要 modelId 判断 reasoning 配置形式（budget vs effort）。
 * 裸 provider 名（'bedrock'）无法推断家族，warn + 返回空 options。
 */
function resolveBedrockModelId(key: LLMModelKey | string): string | undefined {
  if (!key.includes(':')) {
    autoOptsLogger.warning`[autoOpts] bare provider name "${key}" cannot infer Bedrock model family; pass a full model key (e.g. bedrock:claude-haiku-4.5). Returning empty options`;
    return undefined;
  }
  return getModel(key as LLMModelSpec).modelId;
}

// ============================================================================
// 自动路由客户端
// ============================================================================

/**
 * 根据 Model Key 自动选择客户端
 *
 * @example
 * ```typescript
 * model('openrouter:gemini-2.5-flash')  // → 使用 openrouter 客户端
 * model('google:gemini-2.5-flash')      // → 使用 google 客户端
 * model('vertex-global:gemini-2.5-flash?vertex.tier=priority&vertex.requestType=shared')
 * // → 使用 Vertex project/global 客户端，走官方 Priority PayGo URL
 * ```
 */
export function model(key: LLMModelSpec, modelIdSuffix?: string): LanguageModel {
  const config = getModel(key);
  const modelId = modelIdSuffix ? `${config.modelId}${modelIdSuffix}` : config.modelId;
  const provider = config.provider as LLMProviderType;

  switch (provider) {
    case 'openrouter':
      return openrouter(modelId);
    case 'google':
      return google(modelId);
    case 'vertex':
      return vertex(modelId);
    case 'vertex-global':
      return vertexGlobal(modelId);
    case 'bedrock':
      return bedrock(modelId);
    default:
      throw Oops.Panic.Config(`Unknown provider: ${provider as string} for model: ${key}`);
  }
}

/**
 * 从 Model Key 解析 Provider
 *
 * 支持两种格式：
 * - Provider 名：`'openrouter'` | `'google'` | `'vertex'` | `'vertex-global'`
 * - Model Key：`'openrouter:x-ai/grok-4.1-fast'`
 *
 * @example
 * ```typescript
 * parseProvider('openrouter')                    // => 'openrouter'
 * parseProvider('openrouter:x-ai/grok-4.1-fast') // => 'openrouter'
 * parseProvider('google:gemini-2.5-flash')       // => 'google'
 * parseProvider('vertex-global:gemini-2.5-flash') // => 'vertex-global'
 * ```
 */
export function parseProvider(key: string): LLMProviderType {
  // 支持直接传 provider 名（如 'openrouter'）
  const validProviders: LLMProviderType[] = ['openrouter', 'google', 'vertex', 'vertex-global', 'bedrock'];
  if (validProviders.includes(key as LLMProviderType)) {
    return key as LLMProviderType;
  }

  // 否则解析 provider:model 格式
  const colonIndex = key.indexOf(':');
  if (colonIndex === -1) {
    throw Oops.Panic.Config(`Invalid model key format: ${key}, expected "provider:model" or provider name`);
  }
  return key.slice(0, colonIndex) as LLMProviderType;
}

// ============================================================================
// 自动路由 Options
// ============================================================================

/**
 * 根据 Provider/Model Key 自动生成 providerOptions。
 *
 * 完整 model key 会读取 registry contract；裸 provider 名只保留无法判断模型能力的
 * legacy provider-level 行为。
 */
export const autoOpts = {
  /**
   * 禁用 Thinking/Reasoning
   *
   * 完整 model key 会遵守 mandatory reasoning、default effort 与 Google thinking mode；
   * 裸 provider 名则使用旧的 provider-level 格式。
   *
   * @param key Provider 名或 Model Key
   *
   * @example
   * ```typescript
   * // 推荐：传完整 model key，确保应用 registry contract
   * providerOptions: autoOpts.noThinking('openrouter:x-ai/grok-4.1-fast'),
   *
   * // Legacy：裸 provider 名无法判断模型是否允许关闭 reasoning
   * providerOptions: autoOpts.noThinking('openrouter'),
   * ```
   */
  noThinking(key: LLMModelKey | string): ProviderOptions {
    const contract = resolveAutoOptsModelContract(key);
    if (contract) {
      const provider = contract.config.provider as LLMProviderType;
      const { thinking, paramFallbackApplied } = resolveThinkingForModel(contract.key, 'none');
      if (paramFallbackApplied) {
        autoOptsLogger.warning`[autoOpts] ${contract.key} forbids thinking=none; param-fallback to thinking=${thinking}`;
      }
      return thinking === 'none'
        ? disableThinkingOptions(provider, contract.config.modelId)
        : reasoningEffortOptions(provider, thinking, contract.config.modelId, contract.config.googleThinkingMode);
    }

    const provider = parseProvider(key);
    switch (provider) {
      case 'openrouter':
        // ⚠️ 注意：Grok 4.1 Fast 无法关闭 reasoning（effort/enabled 参数均无效）
        // 如需低 TTFT，请使用 Gemini 2.5 Flash
        // @see ~/.claude/gotchas/openrouter-grok-reasoning-cannot-disable.md
        return { openrouter: { reasoning: { effort: 'none' } } };
      case 'google':
      case 'vertex': // Vertex 使用与 Google 相同的 providerOptions 格式
      case 'vertex-global':
        return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      case 'bedrock': {
        // Bedrock reasoningConfig 按模型家族区分；不支持的家族返回空 options
        const modelId = resolveBedrockModelId(key);
        return modelId ? bedrockThinkingOptions(modelId, 'none') : {};
      }
      default:
        return {};
    }
  },

  /**
   * 设置推理强度（自动根据 provider 选择正确格式）
   */
  thinking(key: LLMModelKey | string, effort: 'low' | 'medium' | 'high'): ProviderOptions {
    const contract = resolveAutoOptsModelContract(key);
    if (contract) {
      return reasoningEffortOptions(
        contract.config.provider as LLMProviderType,
        effort,
        contract.config.modelId,
        contract.config.googleThinkingMode,
      );
    }

    const provider = parseProvider(key);
    const budgetMap = { low: 1024, medium: 4096, high: 8192 } as const;

    switch (provider) {
      case 'openrouter':
        return { openrouter: { reasoning: { effort } } };
      case 'google':
      case 'vertex': // Vertex 使用与 Google 相同的 providerOptions 格式
      case 'vertex-global':
        return { google: { thinkingConfig: { thinkingBudget: budgetMap[effort] } } };
      case 'bedrock': {
        // anthropic 家族 → budgetTokens；nova 2 家族 → maxReasoningEffort；其他 → warn + 空
        const modelId = resolveBedrockModelId(key);
        return modelId ? bedrockThinkingOptions(modelId, effort) : {};
      }
      default:
        return {};
    }
  },
};
