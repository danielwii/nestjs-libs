/**
 * 场景化 Options Helpers
 *
 * 提供常用场景的便利函数，自动处理不同 Provider 的差异
 */

import { googleOptions } from './google.client';
import { openrouterOptions } from './openrouter.client';

/**
 * Provider 类型
 */
export type ProviderType = 'openrouter' | 'google' | 'vertex';

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
export function disableThinkingOptions(provider: ProviderType) {
  switch (provider) {
    case 'openrouter':
      return openrouterOptions({ disableThinking: true });
    case 'google':
    case 'vertex':
      return googleOptions({ disableThinking: true });
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
export function reasoningEffortOptions(provider: ProviderType, effort: 'low' | 'medium' | 'high') {
  switch (provider) {
    case 'openrouter':
      return openrouterOptions({ reasoningEffort: effort });
    case 'google':
    case 'vertex': {
      // Google/Vertex 没有 effort 概念，用 thinkingBudget 近似
      // low: 1024, medium: 4096, high: 8192
      const budgetMap = { low: 1024, medium: 4096, high: 8192 };
      return googleOptions({ thinkingBudget: budgetMap[effort] });
    }
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
