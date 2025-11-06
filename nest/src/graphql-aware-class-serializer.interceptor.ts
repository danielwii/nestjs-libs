import { GqlExecutionContext } from '@nestjs/graphql';

import { ClassSerializerInterceptor } from '@nestjs/common';
import { isObservable } from 'rxjs';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Observable, Subscription } from 'rxjs';

/**
 * GraphQL-aware ClassSerializerInterceptor
 *
 * 设计意图：
 * - 保持 HTTP/GraphQL Query/Mutation 的序列化逻辑不变
 * - 对 GraphQL Subscription 返回值不做拦截，防止 async iterator 被转换成 Observable
 */
/**
 * 重要：GraphQL subscription 场景下 NestJS 默认返回 RxJS Observable，会在 Apollo 层判定为非 AsyncIterable。
 * 我们只对 subscription 做 pass-through，并在需要时把 Observable 适配成 AsyncIterator，
 * 这样既保留 ClassSerializer 的默认行为，又不会破坏 graphql-transport-ws 的协议预期。
 */
export class GraphqlAwareClassSerializerInterceptor extends ClassSerializerInterceptor {
  override intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType<'http' | 'graphql'>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const operation = gqlContext.getInfo()?.operation?.operation;
      if (operation === 'subscription') {
        const result = next.handle();
        if (isObservable(result)) {
          const observable = result;
          const asyncIterator = (observable as unknown as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> })[
            Symbol.asyncIterator
          ];
          if (typeof asyncIterator !== 'function') {
            return observableToAsyncIterator(observable) as unknown as Observable<any>;
          }
        }
        return result;
      }
    }

    return super.intercept(context, next);
  }
}

function observableToAsyncIterator<T>(observable: Observable<T>): AsyncIterableIterator<T> {
  const queue: Array<IteratorResult<T>> = [];
  let pendingResolve: ((value: IteratorResult<T>) => void) | null = null;
  let pendingReject: ((reason?: any) => void) | null = null;
  let error: unknown = null;
  let completed = false;

  const subscription: Subscription = observable.subscribe({
    next(value) {
      if (pendingResolve) {
        pendingResolve({ value, done: false });
        pendingResolve = null;
        pendingReject = null;
      } else {
        queue.push({ value, done: false });
      }
    },
    error(err) {
      if (pendingReject) {
        pendingReject(err);
        pendingResolve = null;
        pendingReject = null;
      } else {
        error = err;
      }
    },
    complete() {
      completed = true;
      if (pendingResolve) {
        pendingResolve({ value: undefined as T, done: true });
        pendingResolve = null;
        pendingReject = null;
      } else {
        queue.push({ value: undefined as T, done: true });
      }
    },
  });

  const iterator: AsyncIterableIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }

      if (error !== null) {
        const err = error;
        error = null;
        return Promise.reject(err);
      }

      if (completed) {
        return Promise.resolve({ value: undefined as T, done: true });
      }

      return new Promise<IteratorResult<T>>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    },
    return(): Promise<IteratorResult<T>> {
      subscription.unsubscribe();
      completed = true;
      queue.length = 0;
      return Promise.resolve({ value: undefined as T, done: true });
    },
    throw(err?: any): Promise<IteratorResult<T>> {
      subscription.unsubscribe();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
}
