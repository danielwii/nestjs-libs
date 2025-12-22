/**
 * Google AI Client Factory
 *
 * 使用 AI SDK + Google Provider 直接访问 Gemini
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';

// 延迟导入 ApiFetcher，避免循环依赖
let cachedFetch: typeof fetch | undefined;
async function getProxyFetch(): Promise<typeof fetch> {
  if (!cachedFetch) {
    const { ApiFetcher } = await import('@app/utils/fetch');
    cachedFetch = ApiFetcher.undiciFetch;
  }
  return cachedFetch;
}

export interface GoogleClientOptions {
  apiKey: string;
  /** 是否使用代理（默认使用 SysProxy 配置） */
  useProxy?: boolean;
  /** 自定义 fetch（不推荐，除非有特殊需求） */
  customFetch?: typeof fetch;
}

/**
 * 创建 Google AI 客户端（AI SDK 兼容）
 *
 * @example
 * ```typescript
 * const google = await createGoogleClient({
 *   apiKey: env.GOOGLE_API_KEY,
 * });
 *
 * // 使用 AI SDK
 * const result = await streamText({
 *   model: google('gemini-2.5-flash'),
 *   messages: [...],
 * });
 * ```
 */
export async function createGoogleClient(options: GoogleClientOptions) {
  const { apiKey, useProxy = true, customFetch } = options;

  const fetchFn = customFetch ?? (useProxy ? await getProxyFetch() : fetch);

  return createGoogleGenerativeAI({
    apiKey,
    fetch: fetchFn,
  });
}

/**
 * Google AI 特有的 providerOptions
 *
 * @example
 * ```typescript
 * await streamText({
 *   model: google('gemini-2.5-flash-thinking'),
 *   messages: [...],
 *   providerOptions: googleOptions({
 *     disableThinking: true,
 *   }),
 * });
 * ```
 */
export function googleOptions(options: {
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

  return {
    google: {
      ...(thinkingConfig && { thinkingConfig }),
      ...(safetySettings && { safetySettings }),
    },
  };
}
