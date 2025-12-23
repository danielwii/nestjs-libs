/**
 * 预设 providerOptions
 *
 * 最简写法，直接使用预设对象
 *
 * @example
 * ```typescript
 * import { openrouter, opts } from '@app/llm-core';
 *
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: opts.openrouter.noThinking,
 * });
 * ```
 */

/**
 * 预设 Options 集合
 */
export const opts = {
  /**
   * OpenRouter 预设
   */
  openrouter: {
    /** 禁用 thinking/reasoning */
    noThinking: {
      openrouter: { reasoningText: { exclude: true } },
    },
    /** 低强度推理 */
    thinkingLow: {
      openrouter: { reasoningText: { effort: 'low' } },
    },
    /** 中等强度推理 */
    thinkingMedium: {
      openrouter: { reasoningText: { effort: 'medium' } },
    },
    /** 高强度推理 */
    thinkingHigh: {
      openrouter: { reasoningText: { effort: 'high' } },
    },
    /** 使用 fallback 路由 */
    fallback: {
      openrouter: { route: 'fallback' },
    },
  },

  /**
   * Google AI 预设
   */
  google: {
    /** 禁用 thinking（thinkingBudget: 0） */
    noThinking: {
      google: { thinkingConfig: { thinkingBudget: 0 } },
    },
    /** 低 thinking 预算（1024 tokens） */
    thinkingLow: {
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    },
    /** 中等 thinking 预算（4096 tokens） */
    thinkingMedium: {
      google: { thinkingConfig: { thinkingBudget: 4096 } },
    },
    /** 高 thinking 预算（8192 tokens） */
    thinkingHigh: {
      google: { thinkingConfig: { thinkingBudget: 8192 } },
    },
  },
} as const;

/**
 * 类型辅助：提取预设的类型
 */
export type OpenRouterPreset = keyof typeof opts.openrouter;
export type GooglePreset = keyof typeof opts.google;
