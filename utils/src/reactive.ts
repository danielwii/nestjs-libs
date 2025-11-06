import _ from 'lodash';

import { Logger } from '@nestjs/common';
import { from, Observable } from 'rxjs';
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
            logger.error(f`#${funcName} generator error ${{ key, e }}`, e.stack);
            observer.error(e);
          }

          completed = true;

          if (answer && !validate(answer)) {
            logger.log(f`#${funcName} cache ${{ key, answer }}`);
            // this.cacheService.cacheManager
            //   .set(key, answer, 60 * 60 * 24 * 1000)
            //   .catch((e) => logger.error(f`#${funcName} cache error ${e}`, e.stack), 'ReactiveUtils);
            onComplete?.(answer);
          } else {
            logger.warn(f`#${funcName} unanswered ${{ key, answer }}`);
          }

          logger.log(f`#${funcName} complete ... ${key}`);
          observer.complete();
        } catch (e: any) {
          logger.error(f`#${funcName} error ${{ key, completed, error: e }}`, e.stack);
          observer.error('no answer');
        }
      })();

      return () => {
        logger.log(f`#${funcName} unsubscribe ... ${{ key, completed }}`);
      };
    });
  }
}

const logger = new Logger(ReactiveUtils.name);
