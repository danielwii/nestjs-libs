import * as NodeFetch from 'node-fetch';
import * as Undici from 'undici';

import { Logger } from '@nestjs/common';
import { f, errorStack } from './utils';
import { SysProxy } from '@app/env';

export class ApiFetcher {
  private static readonly logger = new Logger(this.constructor.name);
  private static readonly DEFAULT_TIMEOUT = 30e3;

  /**
   * 基于 undici 的 fetch 实现，支持代理
   *
   * 类型断言说明：
   * - @types/bun 扩展了全局 fetch 类型，添加了 preconnect 静态方法
   * - 使用 as typeof fetch 确保与 AI SDK 等库的 fetch 参数类型兼容
   * - 实际运行时不需要 preconnect，只需要函数调用签名
   */
  static undiciFetch = (async (
    url: string | URL | Request,
    options?: RequestInit & { duplex?: Undici.RequestDuplex },
  ): Promise<Response> => {
    const response = await Undici.fetch(
      url as string,
      { ...options, dispatcher: SysProxy.dispatcher } as unknown as Undici.RequestInit,
    );
    return response as unknown as Response;
  }) as typeof fetch;

  static async nodeFetch(url: string | URL | Request, options?: RequestInit & { timeout?: number }): Promise<Response> {
    return NodeFetch.default(
      url as unknown as NodeFetch.RequestInfo,
      { ...options, agent: SysProxy.agent } as NodeFetch.RequestInit,
    ) as unknown as Promise<Response>;
  }

  static async fetch(url: RequestInfo, options?: RequestInit & { timeout?: number }) {
    const timeout = options?.timeout ?? ApiFetcher.DEFAULT_TIMEOUT;
    const now = Date.now();
    this.logger.log(f`<ApiFetcher> #fetch ${url}`);

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    const response = await NodeFetch.default(
      url as unknown as NodeFetch.RequestInfo,
      { ...options, signal: controller.signal, agent: SysProxy.agent } as unknown as NodeFetch.RequestInit,
    )
      .catch((e: unknown) => {
        this.logger.error(
          f`<ApiFetcher> #fetch ${url} error ${e instanceof Error ? e.message : 'unknown'} ${Date.now() - now}ms...`,
          errorStack(e),
        );
        throw new Error(`<ApiFetcher> #fetch error ${e instanceof Error ? e.message : 'unknown'}...`);
      })
      .finally(() => clearTimeout(id));

    this.logger.debug(f`<ApiFetcher> #fetch ${url} ${Date.now() - now}ms...`);
    if (response instanceof Error) throw response;
    if (response.ok) return response;

    this.logger.error(f`<ApiFetcher> #fetch ${url} response ${response.status} ${response.statusText}...`);
    throw new Error(`<ApiFetcher> #fetch response ${response.status} ${response.statusText}...`);
  }

  static async fetchJson<T>(url: RequestInfo, options?: RequestInit) {
    const response = await this.fetch(url, options);
    return (await response.json()) as T;
  }
}
