import { Logger } from '@nestjs/common';
import * as NodeFetch from 'node-fetch';
import * as Undici from 'undici';

import { f, onelineStackFromError } from './utils';
import { SysProxy } from '@app/env';

export class ApiFetcher {
  private static readonly logger = new Logger(this.constructor.name);
  private static readonly DEFAULT_TIMEOUT = 30e3;

  static async undiciFetch(
    url: string | URL | Request,
    options?: RequestInit & { duplex?: Undici.RequestDuplex },
  ): Promise<Response> {
    const response = await Undici.fetch(
      url as string,
      { ...options, dispatcher: SysProxy.dispatcher } as unknown as Undici.RequestInit,
    );
    return response as unknown as Response;
  }

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
          onelineStackFromError(e),
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
