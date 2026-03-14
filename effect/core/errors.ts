/**
 * Effect 错误体系
 *
 * 每个 TaggedError 通过 HttpApiSchema.annotations 自带 HTTP 状态码。
 * 用于 HttpApi 声明式 API 时，框架自动将错误映射为对应状态码的响应。
 *
 * 使用方式：
 * ```ts
 * const endpoint = HttpApiEndpoint.get("getUser", "/users/:id")
 *   .addSuccess(UserSchema)
 *   .addError(NotFoundError)   // 框架读取 status: 404
 *   .addError(UnauthorizedError) // 框架读取 status: 401
 * ```
 */

import { HttpApiSchema } from '@effect/platform';
import { Schema } from 'effect';

// ==================== 错误分类 ====================

/** 客户端错误：请求参数非法等 */
export class ClientError extends Schema.TaggedError<ClientError>()(
  'ClientError',
  { message: Schema.String, code: Schema.optional(Schema.String) },
  HttpApiSchema.annotations({ status: 400 }),
) {}

/** 业务规则违反：余额不足、操作冲突等 */
export class BusinessError extends Schema.TaggedError<BusinessError>()(
  'BusinessError',
  { message: Schema.String, code: Schema.optional(Schema.String) },
  HttpApiSchema.annotations({ status: 422 }),
) {}

/** 外部服务错误：第三方 API 超时、不可用等 */
export class ExternalError extends Schema.TaggedError<ExternalError>()(
  'ExternalError',
  { message: Schema.String, service: Schema.optional(Schema.String) },
  HttpApiSchema.annotations({ status: 502 }),
) {}

/** 系统错误：数据库连接失败、内存不足等 */
export class SystemError extends Schema.TaggedError<SystemError>()(
  'SystemError',
  { message: Schema.String, code: Schema.optional(Schema.String) },
  HttpApiSchema.annotations({ status: 500 }),
) {}

/** 数据错误：数据不一致等 */
export class DataError extends Schema.TaggedError<DataError>()(
  'DataError',
  { message: Schema.String, entity: Schema.optional(Schema.String), id: Schema.optional(Schema.String) },
  HttpApiSchema.annotations({ status: 500 }),
) {}

// ==================== 常用快捷错误 ====================

/** 资源未找到 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  'NotFoundError',
  { message: Schema.String, entity: Schema.optional(Schema.String), id: Schema.optional(Schema.String) },
  HttpApiSchema.annotations({ status: 404 }),
) {}

/** 认证失败 */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  'UnauthorizedError',
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

/** 权限不足 */
export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()(
  'ForbiddenError',
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 403 }),
) {}

/** 参数验证失败 */
export class ValidationError extends Schema.TaggedError<ValidationError>()(
  'ValidationError',
  {
    message: Schema.String,
    errors: Schema.optional(Schema.Array(Schema.Struct({ field: Schema.String, message: Schema.String }))),
  },
  HttpApiSchema.annotations({ status: 400 }),
) {}
