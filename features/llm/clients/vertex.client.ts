/**
 * Google Vertex AI Client Factory (Express Mode)
 *
 * 使用 AI SDK + Vertex Provider，通过 API Key 直接访问 Gemini
 * Express Mode 不需要配置 project 和 location
 */

import { createVertex } from '@ai-sdk/google-vertex';

/**
 * Vertex AI 特有的 providerOptions
 *
 * 注意：Vertex 使用 google 作为 providerOptions key（与 Google AI Studio 相同）
 *
 * @example
 * ```typescript
 * await streamText({
 *   model: vertex('gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: vertexOptions({
 *     disableThinking: true,
 *   }),
 * });
 * ```
 */
export function vertexOptions(options: {
  /** 禁用 thinking 输出（设置 thinkingBudget: 0） */
  disableThinking?: boolean;
  /** Thinking token 预算（仅对 thinking 模型有效） */
  thinkingBudget?: number;
  /** 安全设置 */
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
}) {
  const { disableThinking, thinkingBudget, safetySettings } = options;

  const thinkingConfig = (() => {
    if (disableThinking) {
      return { thinkingBudget: 0 };
    }
    if (thinkingBudget !== undefined) {
      return { thinkingBudget };
    }
    return undefined;
  })();

  // Vertex 使用 google 作为 providerOptions key
  return {
    google: {
      ...(thinkingConfig && { thinkingConfig }),
      ...(safetySettings && { safetySettings }),
    },
  };
}

export { createVertex };
