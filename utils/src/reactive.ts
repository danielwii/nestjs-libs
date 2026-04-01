import { getAppLogger } from '@app/utils/app-logger';

import * as _ from 'radash';
import { filter, from, Observable } from 'rxjs';

export class ReactiveUtils {
  // AI SDK generator 可能 yield null/undefined
  static fromAsyncGenerator(
    key: string,
    generator: AsyncGenerator<string | null | undefined>,
    { validate, onComplete }: { validate: (message: string) => boolean; onComplete?: (message: string) => void },
    funcName?: string,
  ): Observable<string> {
    const methodName = funcName ?? 'fromAsyncGenerator';

    // 无缓存 key 时直接转换，过滤 null/undefined 保持返回类型契约
    if (!key.trim()) return from(generator).pipe(filter((v): v is string => v != null));

    return new Observable((observer) => {
      let completed = false;
      void (async () => {
        // const cached: string = await this.cacheService.cacheManager.get(key);
        // if (cached) {
        //   if (this.invalidAnswer(cached)) {
        //     ReactiveUtils.logger.verbose(f`#${methodName} invalid cache ${key}`);
        //     this.cacheService.cacheManager
        //       .del(key)
        //       .catch((e) => ReactiveUtils.logger.error(f`#${methodName} cache error ${e}`, e.stack));
        //   } else {
        //     ReactiveUtils.logger.log(f`#${methodName} cached ${{ key, cached: cached.slice(0, 100) + '...' }}`);
        //     observer.next(cached);
        //     return observer.complete();
        //   }
        // }

        try {
          let answer = '';
          try {
            for await (const value of generator) {
              if (value == null) continue;

              answer += value;
              observer.next(value);
            }
          } catch (e: unknown) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error`#${methodName} generator error ${{ key, e: error }}`;
            observer.error(error);
          }

          completed = true;

          if (answer && !validate(answer)) {
            logger.info`#${methodName} cache ${{ key, answer }}`;
            // this.cacheService.cacheManager
            //   .set(key, answer, 60 * 60 * 24 * 1000)
            //   .catch((e) => logger.error`#${methodName} cache error ${e}`);
            onComplete?.(answer);
          } else {
            logger.warning`#${methodName} unanswered ${{ key, answer }}`;
          }

          logger.info`#${methodName} complete ... ${key}`;
          observer.complete();
        } catch (e: unknown) {
          const error = e instanceof Error ? e : new Error(String(e));
          logger.error`#${methodName} error ${{ key, completed, error }}`;
          observer.error('no answer');
        }
      })();

      return () => {
        logger.info`#${methodName} unsubscribe ... ${{ key, completed }}`;
      };
    });
  }
}

const logger = getAppLogger('ReactiveUtils');
