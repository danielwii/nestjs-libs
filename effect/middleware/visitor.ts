/**
 * Visitor Middleware — 访客追踪
 *
 * 对标 NestJS VisitorInterceptor：
 * - 从 x-visitor-id header 提取访客 ID
 * - 注入 X-Trace-Id 响应头（OTel trace ID）
 *
 * Effect 模式：HttpMiddleware（替代 NestJS Interceptor）
 */

import { HttpServerRequest } from '@effect/platform';
import { Context, Effect } from 'effect';

// ==================== VisitorId Context ====================

/** 当前请求的访客 ID（来自 x-visitor-id header） */
export class VisitorId extends Context.Tag('VisitorId')<VisitorId, string | undefined>() {}

/**
 * 从请求中提取 visitor ID
 *
 * 在 HttpApi handler 中使用：
 * ```ts
 * handlers.handle("getUser", () =>
 *   Effect.gen(function* () {
 *     const visitorId = yield* extractVisitorId;
 *     // ...
 *   }),
 * );
 * ```
 */
export const extractVisitorId = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return request.headers['x-visitor-id'];
});
