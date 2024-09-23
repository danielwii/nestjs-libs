import { Logger } from '@nestjs/common';

import fetch, { RequestInfo, RequestInit } from 'node-fetch';

export class ApiFetcher {
  private static readonly logger = new Logger(this.constructor.name);
  private static readonly DEFAULT_TIMEOUT = 30e3;

  static async fetch(url: RequestInfo, options?: RequestInit & { timeout?: number }) {
    const timeout = options?.timeout ?? ApiFetcher.DEFAULT_TIMEOUT;
    const now = Date.now();
    this.logger.log(`<ApiFetcher> #fetch ${url}`);

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, { ...options, signal: controller.signal as any })
      .catch((e) => {
        this.logger.error(`<ApiFetcher> #fetch ${url} error ${e.message} ${Date.now() - now}ms...`, e.stack);
        throw new Error(`<ApiFetcher> #fetch error ${e.message}...`);
      })
      .finally(() => clearTimeout(id));

    this.logger.debug(`<ApiFetcher> #fetch ${url} ${Date.now() - now}ms...`);
    if (response instanceof Error) throw response;
    if (response.ok) return response;

    this.logger.error(`<ApiFetcher> #fetch ${url} response ${response.status} ${response.statusText}...`);
    throw new Error(`<ApiFetcher> #fetch response ${response.status} ${response.statusText}...`);
  }

  static async fetchJson<T>(url: RequestInfo, options?: RequestInit) {
    const response = await this.fetch(url, options);
    return (await response.json()) as T;
  }
}
