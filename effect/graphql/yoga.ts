/**
 * graphql-yoga ↔ @effect/platform 桥接
 *
 * 将 yoga handler 包装为 Effect HttpApp，可挂载到 HttpRouter：
 * ```ts
 * const yoga = createYoga({ schema });
 * const router = HttpRouter.empty.pipe(
 *   HttpRouter.all('/graphql', yogaHttpApp(yoga)),
 * );
 * ```
 *
 * 关键：@effect/platform 提供 Request/Response ↔ HttpServerRequest/Response 双向转换，
 * 因此 yoga 的 web-standard handler 可以零适配地挂载。
 */

import { HttpServerRequest, HttpServerResponse } from '@effect/platform';
import { Effect } from 'effect';

import type { YogaServerInstance } from 'graphql-yoga';

/**
 * 将 graphql-yoga 实例包装为 Effect HttpApp
 *
 * yoga.handle() 接受 web-standard Request，返回 Response。
 * 这里做的就是双向转换。
 */
export const yogaHttpApp = (yoga: YogaServerInstance<object, object>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const webResponse = yield* Effect.promise(() => Promise.resolve(yoga.handle(webRequest)));
    return HttpServerResponse.fromWeb(webResponse);
  });
