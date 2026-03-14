/**
 * Local-Only Guard — 内网 API 保护
 *
 * 对标 NestJS LocalOnlyGuard：
 * - 只允许 localhost (127.0.0.1 / ::1) 访问
 * - K8s LB/proxy 的请求 IP 不是 127.0.0.1，天然被挡
 * - kubectl port-forward / exec 是 127.0.0.1，正常通过
 * - 不信任 X-Forwarded-For（可伪造）
 *
 * Effect 模式：返回 Effect<void, ForbiddenError> 的守卫函数
 *
 * 用法：
 * ```ts
 * handlers.handle("sentryDebug", () =>
 *   requireLocalOnly.pipe(
 *     Effect.flatMap(() => handleSentryDebug()),
 *   ),
 * );
 * ```
 */

import { ForbiddenError } from '../core/errors';

import { HttpServerRequest } from '@effect/platform';
import { Effect, Option } from 'effect';

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 要求请求来自 localhost，否则返回 ForbiddenError
 */
export const requireLocalOnly = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const ip = Option.getOrUndefined(request.remoteAddress);

  if (!ip || !LOCALHOST_IPS.has(ip)) {
    return yield* new ForbiddenError({ message: 'This endpoint is only accessible from localhost' });
  }
});
