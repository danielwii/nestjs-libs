/**
 * OpenRouter Client Factory
 *
 * 使用 @openrouter/ai-sdk-provider 访问 OpenRouter
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import type { OpenRouterModelOptions, OpenRouterProviderRouting } from '../types/model.types';
import type { JSONObject } from '@ai-sdk/provider';

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

export type OpenRouterRoutingProfile = { kind: 'auto' } | { kind: 'provider'; provider: OpenRouterProviderRouting };

const openRouterRoutingProfiles = new Map<string, OpenRouterRoutingProfile>([
  ['auto', { kind: 'auto' }],
  ['latency', { kind: 'provider', provider: { sort: 'latency' } }],
  ['bedrock', { kind: 'provider', provider: { only: ['amazon-bedrock'], allowFallbacks: false } }],
]);

export function registerOpenRouterRoutingProfile(name: string, profile: OpenRouterRoutingProfile): void {
  openRouterRoutingProfiles.set(name, profile);
}

export function getOpenRouterRoutingProfile(name: string): OpenRouterRoutingProfile | undefined {
  return openRouterRoutingProfiles.get(name);
}

export function mergeOpenRouterProviderRouting(
  ...routings: Array<OpenRouterProviderRouting | undefined>
): OpenRouterProviderRouting | undefined {
  let merged: OpenRouterProviderRouting | undefined;
  for (const routing of routings) {
    if (!routing) continue;
    merged = {
      ...(merged ?? {}),
      ...routing,
      ...(merged?.extra || routing.extra ? { extra: { ...(merged?.extra ?? {}), ...(routing.extra ?? {}) } } : {}),
    };
  }
  return merged;
}

export function mergeOpenRouterOptions(
  ...options: Array<OpenRouterModelOptions | undefined>
): OpenRouterModelOptions | undefined {
  let routing: string | undefined;
  let provider: OpenRouterProviderRouting | undefined;

  for (const option of options) {
    if (!option) continue;
    if (option.routing !== undefined) {
      routing = option.routing;
    }
    provider = mergeOpenRouterProviderRouting(provider, option.provider);
  }

  return routing !== undefined || provider !== undefined
    ? {
        ...(routing !== undefined ? { routing } : {}),
        ...(provider !== undefined ? { provider } : {}),
      }
    : undefined;
}

function normalizeOpenRouterProviderRouting(routing: OpenRouterProviderRouting | undefined): JSONObject | undefined {
  if (!routing) return undefined;

  const { order, only, ignore, allowFallbacks, requireParameters, sort, extra } = routing;
  const payload: Record<string, unknown> = {
    ...(order !== undefined ? { order: [...order] } : {}),
    ...(only !== undefined ? { only: [...only] } : {}),
    ...(ignore !== undefined ? { ignore: [...ignore] } : {}),
    ...(allowFallbacks !== undefined ? { allow_fallbacks: allowFallbacks } : {}),
    ...(requireParameters !== undefined ? { require_parameters: requireParameters } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(extra ?? {}),
  };

  return Object.keys(payload).length > 0 ? (payload as JSONObject) : undefined;
}

export function resolveOpenRouterOptions(
  options: OpenRouterModelOptions | undefined,
  onUnknownProfile?: (name: string) => void,
): { openrouter?: JSONObject } | undefined {
  if (!options) return undefined;

  const profile = options.routing !== undefined ? getOpenRouterRoutingProfile(options.routing) : undefined;
  if (options.routing !== undefined && !profile) {
    onUnknownProfile?.(options.routing);
  }

  const profileProvider = profile?.kind === 'provider' ? profile.provider : undefined;
  const provider = normalizeOpenRouterProviderRouting(
    mergeOpenRouterProviderRouting(profileProvider, options.provider),
  );

  if (!provider) return undefined;
  return { openrouter: { provider } };
}

/**
 * 创建 OpenRouter 客户端（AI SDK 兼容）
 *
 * @example
 * ```typescript
 * const openrouter = await createOpenRouterClient({
 *   apiKey: env.AI_OPENROUTER_API_KEY,
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
  /** Provider routing 配置（camelCase，返回时转成 OpenRouter payload） */
  provider?: OpenRouterProviderRouting;
  /** 其他透传参数 */
  extra?: Record<string, unknown>;
}) {
  const { disableThinking, reasoningEffort, route, provider, extra } = options;

  const reasoning = (() => {
    if (disableThinking) {
      // 同时传 enabled: false 和 effort: 'none' 以确保兼容性
      // Grok 4.5/4.6 LIVE 2026-08-15：raw disable → 400 mandatory（4.1 Fast 已 404 deprecated）
      return { enabled: false, effort: 'none' };
    }
    if (reasoningEffort) {
      return { effort: reasoningEffort };
    }
    return undefined;
  })();

  const providerConfig = normalizeOpenRouterProviderRouting(provider);

  return {
    openrouter: {
      ...(reasoning && { reasoning }),
      ...(route && { route }),
      ...(providerConfig && { provider: providerConfig }),
      ...extra,
    },
  };
}
