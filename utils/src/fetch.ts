import * as NodeFetch from 'node-fetch';
import * as Undici from 'undici';

import { Logger } from '@nestjs/common';
import { f, errorStack } from './utils';
import { SysProxy } from '@app/env';

/**
 * 检测是否在 Bun 运行时中运行
 *
 * 使用 globalThis 访问避免 TypeScript 类型错误
 * Bun 运行时会在全局暴露 Bun 对象
 */
const isBunRuntime = (): boolean => 'Bun' in globalThis;

export class ApiFetcher {
  private static readonly logger = new Logger(this.constructor.name);
  private static readonly DEFAULT_TIMEOUT = 30e3;

  /**
   * 支持代理的 fetch 实现
   *
   * 运行时检测：
   * - Bun: 使用原生 fetch + proxy 选项（Bun 1.3.4+）
   * - Node: 使用 undici fetch + dispatcher
   *
   * 类型断言：as typeof fetch 确保与 AI SDK 等库的 fetch 参数类型兼容
   */
  static undiciFetch = (async (
    url: string | URL | Request,
    options?: RequestInit & { duplex?: Undici.RequestDuplex },
  ): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

    const isBun = isBunRuntime();

    if (isBun && SysProxy.proxy) {
      // Bun 运行时 + 有代理：使用原生 fetch + proxy 选项
      ApiFetcher.logger.log(f`#undiciFetch [Bun] proxy=${SysProxy.proxy} url=${urlStr}`);
      const response = await fetch(url as string, {
        ...options,
        proxy: SysProxy.proxy, // Bun 1.3.4+ 原生支持
      });
      return response;
    }

    // Node 运行时 或 Bun 无代理：使用 undici fetch + dispatcher
    const runtime = isBun ? 'Bun-fallback' : 'Node';
    ApiFetcher.logger.log(f`#undiciFetch [${runtime}] hasDispatcher=${!!SysProxy.dispatcher} url=${urlStr}`);
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
