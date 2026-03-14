/**
 * 认证中间件（HttpApi 声明式模式）
 *
 * 用法：
 * ```ts
 * // 定义 API group 并应用认证
 * const usersGroup = HttpApiGroup.make("users")
 *   .add(HttpApiEndpoint.get("me", "/me").addSuccess(UserSchema))
 *   .middleware(AuthMiddleware);
 *
 * // 实现认证逻辑
 * const AuthLive = Layer.succeed(
 *   AuthMiddleware,
 *   AuthMiddleware.of({
 *     myBearer: (token) =>
 *       pipe(
 *         verifyJwt(token),
 *         Effect.map((payload) => new CurrentUser({ id: payload.sub })),
 *       ),
 *   }),
 * );
 * ```
 */

import { UnauthorizedError } from '../core/errors';

import { HttpApiMiddleware, HttpApiSecurity } from '@effect/platform';
import { Context } from 'effect';

// ==================== CurrentUser 上下文 ====================

export class CurrentUser extends Context.Tag('CurrentUser')<
  CurrentUser,
  { readonly id: string; readonly email?: string; readonly roles?: ReadonlyArray<string> }
>() {}

// ==================== 声明式认证中间件 ====================

export class AuthMiddleware extends HttpApiMiddleware.Tag<AuthMiddleware>()('AuthMiddleware', {
  failure: UnauthorizedError,
  provides: CurrentUser,
  security: { myBearer: HttpApiSecurity.bearer },
}) {}
