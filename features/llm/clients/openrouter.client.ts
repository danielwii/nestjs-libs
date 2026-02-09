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
    cachedFetch = ApiFetcher.fetch;
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
  /**
   * Provider 排序策略（禁用负载均衡，按指定属性排序）
   * - 'price': 优先最低价格
   * - 'throughput': 优先最高吞吐量
   * - 'latency': 优先最低延迟
   */
  providerSort?: 'price' | 'throughput' | 'latency';
  /** 其他透传参数 */
  extra?: Record<string, unknown>;
}) {
  const { disableThinking, reasoningEffort, route, providerOrder, providerSort, extra } = options;

  const reasoning = (() => {
    if (disableThinking) {
      // 同时传 enabled: false 和 effort: 'none' 以确保兼容性
      // ⚠️ 注意：Grok 4.1 Fast 实测无法关闭 reasoning（enabled/effort 参数均无效）
      // @see ~/.claude/gotchas/openrouter-grok-reasoning-cannot-disable.md
      return { enabled: false, effort: 'none' };
    }
    if (reasoningEffort) {
      return { effort: reasoningEffort };
    }
    return undefined;
  })();

  // 构建 provider 配置
  const providerConfig = {
    ...(providerOrder && { order: providerOrder }),
    ...(providerSort && { sort: providerSort }),
  };

  return {
    openrouter: {
      ...(reasoning && { reasoning }),
      ...(route && { route }),
      ...(Object.keys(providerConfig).length > 0 && { provider: providerConfig }),
      ...extra,
    },
  };
}
