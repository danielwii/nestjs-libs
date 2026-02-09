import { Logger } from '@nestjs/common';

import { SysProxy } from '@app/env';

import { f } from './logging';

/**
 * 支持代理的 fetch 包装
 *
 * Bun 原生 fetch 支持 proxy 选项（Bun 1.3.4+），无需第三方库。
 * 类型断言 as typeof fetch 确保与 AI SDK 等库的 fetch 参数类型兼容。
 */
export class ApiFetcher {
  private static readonly logger = new Logger(this.constructor.name);

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

    ApiFetcher.logger.debug(
      f`#fetch url=${urlStr} method=${method} bodyLen=${bodyLength} contentType=${contentType} hasAuth=${hasAuth} proxy=${!!SysProxy.proxy}`,
    );

    return fetch(url as string, {
      ...options,
      ...(SysProxy.proxy ? { proxy: SysProxy.proxy } : {}),
    });
  }) as typeof fetch;
}
