import { Logger } from '@nestjs/common';
import { from, Observable } from 'rxjs';
import _ from 'lodash';

import { named } from './annotation';
import { f } from './utils';

export class ReactiveUtils {
  @named
  static fromAsyncGenerator(
    key: string,
    generator: AsyncGenerator<string>,
    { validate, onComplete }: { validate: (message: string) => boolean; onComplete?: (message: string) => any },
    funcName?: string,
  ): Observable<string> {
    if (!_.trim(key)) return from(generator);

    return new Observable((observer) => {
      let completed = false;
      (async () => {
        // const cached: string = await this.cacheService.cacheManager.get(key);
        // if (cached) {
        //   if (this.invalidAnswer(cached)) {
        //     ReactiveUtils.logger.verbose(f`#${funcName} invalid cache ${key}`);
        //     this.cacheService.cacheManager
        //       .del(key)
        //       .catch((e) => ReactiveUtils.logger.error(f`#${funcName} cache error ${e}`, e.stack));
        //   } else {
        //     ReactiveUtils.logger.log(f`#${funcName} cached ${{ key, cached: cached.slice(0, 100) + '...' }}`);
        //     observer.next(cached);
        //     return observer.complete();
        //   }
        // }

        try {
          let answer = '';
          try {
            for await (const value of generator) {
              if (_.isNil(value)) continue;

              answer += value;
              observer.next(value);
            }
          } catch (e: any) {
            Logger.error(f`#${funcName} generator error ${{ key, e }}`, e.stack, 'ReactiveUtils');
            observer.error(e);
          }

          completed = true;

          if (answer && !validate(answer)) {
            Logger.log(f`#${funcName} cache ${{ key, answer }}`, 'ReactiveUtils');
            // this.cacheService.cacheManager
            //   .set(key, answer, 60 * 60 * 24 * 1000)
            //   .catch((e) => Logger.error(f`#${funcName} cache error ${e}`, e.stack), 'ReactiveUtils);
            onComplete?.(answer);
          } else {
            Logger.warn(f`#${funcName} unanswered ${{ key, answer }}`, 'ReactiveUtils');
          }

          Logger.log(f`#${funcName} complete ... ${key}`, 'ReactiveUtils');
          observer.complete();
        } catch (e: any) {
          Logger.error(f`#${funcName} error ${{ key, completed, error: e }}`, e.stack, 'ReactiveUtils');
          observer.error('no answer');
        }
      })();

      return () => {
        Logger.log(f`#${funcName} unsubscribe ... ${{ key, completed }}`, 'ReactiveUtils');
      };
    });
  }
}
