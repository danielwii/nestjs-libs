/**
 * OpenRouter Client Factory
 *
 * 使用 @openrouter/ai-sdk-provider 访问 OpenRouter
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// 延迟导入 ApiFetcher，避免循环依赖
let cachedFetch: typeof fetch | undefined;
async function getProxyFetch(): Promise<typeof fetch> {
  if (!cachedFetch) {
    const { ApiFetcher } = await import('@app/utils/fetch');
    cachedFetch = ApiFetcher.undiciFetch;
  }
  return cachedFetch;
}

export interface OpenRouterClientOptions {
  apiKey: string;
  /** 是否使用代理（默认使用 SysProxy 配置） */
  useProxy?: boolean;
  /** 自定义 fetch（不推荐，除非有特殊需求） */
  customFetch?: typeof fetch;
}

/**
 * 创建 OpenRouter 客户端（AI SDK 兼容）
 *
 * @example
 * ```typescript
 * const openrouter = await createOpenRouterClient({
 *   apiKey: env.OPENROUTER_API_KEY,
 * });
 *
 * // 使用 AI SDK
 * const result = await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 * });
 * ```
 */
export async function createOpenRouterClient(options: OpenRouterClientOptions) {
  const { apiKey, useProxy = true, customFetch } = options;

  const fetchFn = customFetch ?? (useProxy ? await getProxyFetch() : fetch);

  return createOpenRouter({
    apiKey,
    fetch: fetchFn,
  });
}

/**
 * OpenRouter 特有的 providerOptions
 *
 * @example
 * ```typescript
 * await streamText({
 *   model: openrouter('google/gemini-2.5-flash'),
 *   messages: [...],
 *   providerOptions: openrouterOptions({
 *     disableThinking: true,
 *   }),
 * });
 * ```
 */
export function openrouterOptions(options: {
  /** 禁用 thinking/reasoning 输出 */
  disableThinking?: boolean;
  /** Reasoning 强度 */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** 路由策略 */
  route?: 'fallback' | string;
  /** Provider 偏好顺序 */
  providerOrder?: string[];
  /** 其他透传参数 */
  extra?: Record<string, unknown>;
}) {
  const { disableThinking, reasoningEffort, route, providerOrder, extra } = options;

  const reasoning = (() => {
    if (disableThinking) {
      return { exclude: true };
    }
    if (reasoningEffort) {
      return { effort: reasoningEffort };
    }
    return undefined;
  })();

  return {
    openrouter: {
      ...(reasoning && { reasoning }),
      ...(route && { route }),
      ...(providerOrder && { provider: { order: providerOrder } }),
      ...extra,
    },
  };
}
