/**
 * 场景化 Options Helpers
 *
 * 提供常用场景的便利函数，自动处理不同 Provider 的差异
 */

import { bedrockThinkingOptions } from './bedrock.client';
import { googleOptions } from './google.client';
import { openrouterOptions } from './openrouter.client';

import type { GoogleThinkingMode } from '../types/model.types';

/**
 * Provider 类型
 */
export type ProviderType = 'openrouter' | 'google' | 'vertex' | 'vertex-global' | 'bedrock';

/**
 * 根据 Provider 类型生成禁用 Thinking 的 options
 *
 * @example
 * ```typescript
 * // OpenRouter
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: disableThinkingOptions('openrouter'),
 * });
 *
 * // Google
 * await streamText({
 *   model: google('gemini-2.5-flash-thinking'),
 *   messages: [...],
 *   providerOptions: disableThinkingOptions('google'),
 * });
 * ```
 */
export function disableThinkingOptions(provider: ProviderType, modelId?: string) {
  switch (provider) {
    case 'openrouter':
      return openrouterOptions({ disableThinking: true });
    case 'google':
    case 'vertex':
    case 'vertex-global':
      return googleOptions({ disableThinking: true });
    case 'bedrock':
      // Bedrock 需要 modelId 判断家族；缺 modelId 时不下发 disable（与裸 provider 调用兼容）
      return modelId ? bedrockThinkingOptions(modelId, 'none') : {};
    default:
      return {};
  }
}

/**
 * 根据 Provider 类型生成 Reasoning Effort 的 options
 *
 * @example
 * ```typescript
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: reasoningEffortOptions('openrouter', 'low'),
 * });
 * ```
 */
export function reasoningEffortOptions(
  provider: ProviderType,
  effort: 'low' | 'medium' | 'high',
  modelId?: string,
  googleThinkingMode: GoogleThinkingMode = 'budget',
) {
  switch (provider) {
    case 'openrouter':
      return openrouterOptions({ reasoningEffort: effort });
    case 'google':
    case 'vertex':
    case 'vertex-global': {
      if (googleThinkingMode === 'level') {
        return googleOptions({ thinkingLevel: effort });
      }
      // Budget-mode routes 没有离散 effort 参数，用 thinkingBudget 近似。
      // low: 1024, medium: 4096, high: 8192
      const budgetMap = { low: 1024, medium: 4096, high: 8192 };
      return googleOptions({ thinkingBudget: budgetMap[effort] });
    }
    case 'bedrock':
      // anthropic → budgetTokens；nova 2 → maxReasoningEffort；其他家族内部 warn + 空
      return modelId ? bedrockThinkingOptions(modelId, effort) : {};
    default:
      return {};
  }
}

/**
 * 合并多个 providerOptions
 *
 * @example
 * ```typescript
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: mergeProviderOptions(
 *     openrouterOptions({ disableThinking: true }),
 *     openrouterOptions({ route: 'fallback' }),
 *   ),
 * });
 * ```
 */
export function mergeProviderOptions(
  ...options: Array<Record<string, Record<string, unknown>>>
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const opt of options) {
    for (const [provider, config] of Object.entries(opt)) {
      result[provider] ??= {};
      Object.assign(result[provider], config);
    }
  }

  return result;
}
