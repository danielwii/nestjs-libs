/**
 * Google Vertex AI Client Factory (Express Mode)
 *
 * 使用 AI SDK + Vertex Provider，通过 API key 直接访问 Gemini。
 * Express Mode 不需要配置 project/location，URL 不是 Google Priority/Flex PayGo 文档里的
 * `/v1/projects/{project}/locations/global/...` 路径。
 *
 * 需要官方 Priority/Flex PayGo 语义时，使用 `vertex-global:*` model key。
 */

import { createVertex } from '@ai-sdk/google-vertex';

/**
 * Vertex AI 特有的 providerOptions。
 *
 * 注意：`vertex:*` 与 `vertex-global:*` 都使用 google 作为 providerOptions key
 *（与 Google AI Studio 相同）。
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

  // AI SDK 的 Vertex provider 使用 google 作为 providerOptions key；Express/global 模式一致。
  return {
    google: {
      ...(thinkingConfig && { thinkingConfig }),
      ...(safetySettings && { safetySettings }),
    },
  };
}

export { createVertex };
