import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { f } from '@app/utils';

import { Cache } from 'cache-manager';
import { formatDistanceToNow } from 'date-fns';
import { Duration } from 'luxon';

/**
 * very light wrapper around cache-manager v1
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(this.constructor.name);

  static readonly TTL_10M = Duration.fromObject({ minutes: 10 }).toMillis();
  static readonly TTL_1H = Duration.fromObject({ hours: 1 }).toMillis();
  static readonly TTL_2H = Duration.fromObject({ hours: 2 }).toMillis();
  static readonly TTL_1D = Duration.fromObject({ days: 1 }).toMillis();
  static readonly TTL_1W = Duration.fromObject({ weeks: 1 }).toMillis();
  static readonly TTL_1M = Duration.fromObject({ months: 1 }).toMillis();
  static readonly TTL_1Y = Duration.fromObject({ years: 1 }).toMillis();

  constructor(@Inject(CACHE_MANAGER) readonly cacheManager: Cache) {}

  /**
   * !important: ttl 不要小于 5min，否则会导致频繁刷新，建议最少 10min
   * @param key
   * @param fn
   * @param _ttl
   */
  async wrap<T>(key: string, fn: () => Promise<T>, _ttl?: number): Promise<T> {
    const ttl = _ttl || CacheService.TTL_1D;
    const value: T = await this.cacheManager.get(key);
    if (value) {
      const leftInSeconds = await this.cacheManager.store.ttl(key);
      // threshold is the 1/10 of ttl in milliseconds, min is 5min
      const threshold = Math.max(ttl / 1e4, 5 * 60);
      this.logger.verbose(
        f`Cache Hit ${{
          key,
          left: leftInSeconds.toLocaleString(),
          expiresIn: formatDistanceToNow(Date.now() + leftInSeconds * 1000, { includeSeconds: true }),
          threshold: threshold.toLocaleString(),
        }}`,
      );
      if (leftInSeconds < threshold) {
        this.logger.verbose(f`Cache Refresh ${{ key }}...`);
        fn()
          .then(async (value) => {
            await this.cacheManager.store.set(key, value, ttl);
            this.logger.verbose(f`Cache Refreshed ${{ key }}`);
          })
          .catch((e) => this.logger.error(f`Cache Refresh Error ${{ key }}`, e.stack));
      }
      return value;
    }

    this.logger.debug(f`Cache Miss ${key}`);
    return await this.cacheManager.wrap(key, fn, ttl);
  }

  async get<T>(key: string): Promise<T> {
    const value: T = await this.cacheManager.get(key);
    if (value) {
      this.logger.verbose(f`Cache Hit ${{ key }}`);
      return value;
    } else {
      this.logger.verbose(f`Cache Miss ${{ key }}`);
      return null;
    }
  }
}

/*
export function Cached({ ttl, hashFunction }: { ttl?: number; hashFunction: (...args: any[]) => any }) {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor => {
    const originalMethod = descriptor.value;
    Logger.log(f`Cache ${propertyKey}...`);
    descriptor.value = async function (...args: any[]) {
      const hash = hashFunction(args);
      const cache: HitCache = await CachingModule.store.get(hash);
      if (!cache) {
        const value = await originalMethod.apply(this, args);
        Logger.log(f`Cache Miss ${{ propertyKey, hash, value: value?.length, ttl }}`);
        CachingModule.store.set(hash, { value, hits: 0 }, (ttl ?? 60 * 60 * 24 * 7) * 1000).then(console.error);
      } else Logger.log(f`Cache Hit ${{ propertyKey, hash, ttl }}`);
      cache.hits++;
      CachingModule.store.set(hash, cache, (ttl ?? 60 * 60 * 24 * 7) * 1000).then(console.error);
      return cache.value;
    };
    return descriptor;
  };
}
*/
