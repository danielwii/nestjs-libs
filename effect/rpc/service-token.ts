/**
 * RPC Service Token 验证
 *
 * 对标 NestJS GrpcServiceTokenGuard：
 * - 验证请求中的 x-service-token header
 * - 未配置 GRPC_SERVICE_TOKEN 时跳过（本地开发）
 * - 配置后缺少或错误 token → UnauthorizedError
 *
 * 用法：
 * ```ts
 * const handlers = UserRpcs.toLayer({
 *   GetUser: (req) =>
 *     verifyServiceToken.pipe(
 *       Effect.flatMap(() => handleGetUser(req)),
 *     ),
 * });
 * ```
 */

import { UnauthorizedError } from '../core/errors';

import { HttpServerRequest } from '@effect/platform';
import { Config, Effect } from 'effect';

// ==================== Config ====================

const ServiceToken = Config.option(Config.string('GRPC_SERVICE_TOKEN'));

// ==================== Verification ====================

/**
 * 验证服务间 token
 *
 * - 未配置 GRPC_SERVICE_TOKEN → 跳过验证（本地开发模式）
 * - 请求缺少 x-service-token header → UnauthorizedError
 * - token 不匹配 → UnauthorizedError
 */
export const verifyServiceToken = Effect.gen(function* () {
  const tokenConfig = yield* ServiceToken;

  // 未配置 token → 跳过验证（本地开发）
  if (tokenConfig._tag === 'None') return;

  const expectedToken = tokenConfig.value;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = request.headers['x-service-token'];

  if (!token) {
    return yield* new UnauthorizedError({ message: 'Missing service token' });
  }

  if (token !== expectedToken) {
    return yield* new UnauthorizedError({ message: 'Invalid service token' });
  }
});
