import { getLogger } from '@logtape/logtape';

const proxyUrl =
  process.env.APP_PROXY_ENABLED === 'true' ? `${process.env.APP_PROXY_HOST}:${process.env.APP_PROXY_PORT}` : '';

/**
 * 支持代理的 fetch 包装
 *
 * Bun 原生 fetch 支持 proxy 选项（Bun 1.3.4+），无需第三方库。
 * 类型断言 as typeof fetch 确保与 AI SDK 等库的 fetch 参数类型兼容。
 */
export class ApiFetcher {
  private static readonly logger = getLogger(['app', 'ApiFetcher']);

  static fetch = (async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
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
      .debug`#fetch url=${urlStr} method=${method} bodyLen=${bodyLength} contentType=${contentType} hasAuth=${hasAuth} proxy=${!!proxyUrl}`;

    const response = await fetch(url as string, {
      ...options,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
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
