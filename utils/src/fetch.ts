import { SysEnv } from '@app/env';
import { getAppLogger } from '@app/utils/app-logger';
import { openRouterDeniedInit } from '@app/utils/openrouter-deny';

// 代理配置：启动时读取一次，与 SysEnv 保持单一来源
const proxyUrl = SysEnv.APP_PROXY_ENABLED ? `${SysEnv.APP_PROXY_HOST}:${SysEnv.APP_PROXY_PORT}` : '';

/**
 * The part of a URL that is safe to log: origin and path. The query string and fragment (and any user info) are
 * dropped because they commonly carry credentials or request values.
 */
export function urlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // relative or malformed: keep what precedes the first query / fragment delimiter
    return url.split(/[?#]/, 1)[0] ?? '';
  }
}

/**
 * 支持代理的 fetch 包装
 *
 * Bun 原生 fetch 支持 proxy 选项（Bun 1.3.4+），无需第三方库。
 * 类型断言 as typeof fetch 确保与 AI SDK 等库的 fetch 参数类型兼容。
 */
export class ApiFetcher {
  private static readonly logger = getAppLogger('ApiFetcher');

  static fetch = (async (url: string | URL | Request, callerOptions?: RequestInit): Promise<Response> => {
    // A request to OpenRouter always carries data_collection: 'deny' (owner rule bcc433eb, data-exposure spec S11; see
    // openrouter-deny.ts). It is applied first so the logged body length and the Grok check below read the body that is sent.
    const options = openRouterDeniedInit(url, callerOptions);
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = options?.method ?? 'GET';
    const bodyLength = options?.body
      ? typeof options.body === 'string'
        ? options.body.length
        : JSON.stringify(options.body).length
      : 0;

    const headers = options?.headers as Record<string, string> | undefined;
    const contentType = headers?.['content-type'] ?? headers?.['Content-Type'] ?? '-';
    const hasAuth = !!(headers?.['authorization'] ?? headers?.['Authorization']);

    ApiFetcher.logger
      .debug`#fetch url=${urlForLog(urlStr)} method=${method} bodyLen=${bodyLength} contentType=${contentType} hasAuth=${hasAuth} proxy=${!!proxyUrl}`;

    const response = await fetch(url, {
      ...options,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
      // Bun-specific: verbose 每次调用时读 SysEnv，支持 DB 热切换
      ...(SysEnv.LLM_FETCH_VERBOSE ? { verbose: true } : {}),
    });

    // OpenRouter Grok: 过滤 reasoning.encrypted（加密 reasoning blob 无用且浪费 tokens）
    // 仅对 Grok 模型 + 非流式 JSON 响应生效，避免影响其他模型和流式调用
    const responseContentType = response.headers.get('content-type') ?? '';
    if (
      urlStr.includes('openrouter.ai') &&
      responseContentType.includes('application/json') &&
      typeof options?.body === 'string' &&
      options.body.includes('"x-ai/grok-')
    ) {
      return ApiFetcher.stripEncryptedReasoning(response);
    }

    return response;
  }) as typeof fetch;

  /**
   * 拦截 Response body，移除 reasoning_details 中的 encrypted 条目。
   * 返回一个新的 Response，body 已清理。
   */
  private static async stripEncryptedReasoning(response: Response): Promise<Response> {
    const text = await response.text();

    // 快速检查：不包含 encrypted 就直接返回
    if (!text.includes('reasoning.encrypted')) {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    try {
      const json = JSON.parse(text);
      let stripped = 0;

      // 遍历 choices[].message.reasoning_details，移除 type=reasoning.encrypted
      if (json.choices && Array.isArray(json.choices)) {
        for (const choice of json.choices) {
          const details = choice.message?.reasoning_details;
          if (Array.isArray(details)) {
            choice.message.reasoning_details = details.filter((d: Record<string, unknown>) => {
              if (d.type === 'reasoning.encrypted') {
                stripped++;
                return false;
              }
              return true;
            });
          }
        }
      }

      if (stripped > 0) {
        ApiFetcher.logger.debug`#fetch stripped ${stripped} reasoning.encrypted block(s) from OpenRouter response`;
      }

      return new Response(JSON.stringify(json), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      // JSON 解析失败，返回原始内容
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  }
}

/** The only place in this library that holds the OpenRouter API address; callers pass the path that follows it. */
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

/**
 * Sends a request to the OpenRouter API through {@link ApiFetcher.fetch}: proxy, debug log and
 * `provider.data_collection: 'deny'` included. For code that cannot go through the AI SDK provider (a streamed upload,
 * an audio request); the address is not exported on purpose, so that a request cannot be sent to it by another route
 * and miss the deny (data-exposure spec S11).
 *
 * @example openRouterFetch('/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload) })
 */
export function openRouterFetch(path: `/${string}`, init?: RequestInit): Promise<Response> {
  return ApiFetcher.fetch(`${OPENROUTER_API_BASE}${path}`, init);
}
