import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { getErrorName, getResponseMessage } from '@app/utils/error';

import { ErrorCodes, isValidErrorCode } from './error-codes';

import { ZodError } from 'zod';

import type { ErrorCodeValue } from './error-codes';

/**
 * 异常到响应描述符的统一映射结果
 *
 * HTTP 分支拿它填 `ApiRes.failure` + `response.status(httpStatus)`，
 * GraphQL 分支拿它填 `GraphQLError(message, { extensions: { httpStatus, code, userMessage } })`，
 * gRPC 分支拿它填 `{ code, details }`。
 * 三个协议共享同一套"异常 → 状态/码/消息"的映射规则，避免两边漂移。
 */
export interface HttpErrorDescriptor {
  httpStatus: number;
  code: string;
  message: string;
  errors?: unknown;
  /**
   * 日志级别。绝大多数情况下 = httpStatus >= 500 ? 'error' : 'warning'，
   * UnprocessableEntityException 例外：某些 cause 语义是业务预期（warning），
   * 其他 cause 视为未预期错误（error）。
   */
  logLevel: 'warning' | 'error';
}

/**
 * 判断是否为 Prisma 已知请求错误（鸭子类型，不依赖 Prisma 导入）
 *
 * PrismaClientKnownRequestError 结构特征：
 * - code: 'P2002' 等以 'P' 开头的错误码
 * - clientVersion: Prisma 版本字符串
 * - name: 'PrismaClientKnownRequestError'
 */
interface PrismaKnownRequestError {
  code: string;
  message: string;
  clientVersion?: string;
  meta?: unknown;
}

/** 通过 `number` 注解将 enum 字面量类型放宽为 number，避免 `no-unsafe-enum-comparison` 同时不触发 `no-unnecessary-type-assertion`。 */
const SERVER_ERROR_MIN: number = HttpStatus.INTERNAL_SERVER_ERROR;
export function isServerError(status: number): boolean {
  return status >= SERVER_ERROR_MIN;
}

function isPrismaKnownRequestError(e: unknown): e is PrismaKnownRequestError {
  if (typeof e !== 'object' || e === null) return false;

  const err = e as Record<string, unknown>;

  // 检查错误码是否以 'P' 开头（Prisma 约定）
  if (typeof err.code !== 'string' || !err.code.startsWith('P')) return false;

  // 检查是否有 clientVersion（Prisma 特有）
  if ('clientVersion' in err && typeof err.clientVersion === 'string') return true;

  // 检查构造函数名称（备用方案）
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- constructor 来自原型链，Object.create(null) 时不存在
  if (err.constructor?.name === 'PrismaClientKnownRequestError') return true;

  return false;
}

function isThrottlerException(exception: unknown): exception is HttpException {
  return exception instanceof HttpException && getErrorName(exception) === 'ThrottlerException';
}

/**
 * 把"协议层"异常（HttpException 家族 + Zod / Prisma / FetchError）映射为统一的
 * HttpErrorDescriptor。返回 `null` 表示这是未识别的异常，调用方应走 500 兜底 + Sentry。
 *
 * 设计决策：
 * - OopsError **不**进入此函数 —— 它走各协议 filter 的 `instanceof OopsError` 路径
 *  （i18n 翻译 + 细分日志，映射规则不同）。
 * - Pure function，不做日志、不触发 Sentry，仅做数据转换。副作用由调用方执行，便于单元测试。
 * - 新增异常类型时只需在此添加一个 branch，HTTP/GraphQL/gRPC 响应路径自动对齐。
 */
export function toErrorDescriptor(exception: unknown): HttpErrorDescriptor | null {
  if (exception instanceof ZodError) {
    return {
      httpStatus: HttpStatus.BAD_REQUEST,
      code: ErrorCodes.CLIENT_VALIDATION_FAILED,
      message: 'Invalid parameters',
      errors: exception.issues,
      logLevel: 'warning',
    };
  }

  if (exception instanceof BadRequestException) {
    return {
      httpStatus: HttpStatus.BAD_REQUEST,
      code: ErrorCodes.CLIENT_INPUT_ERROR,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (isPrismaKnownRequestError(exception)) {
    return {
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ErrorCodes.SYSTEM_DATABASE_ERROR,
      message: 'Operation failed, please try again later',
      logLevel: 'warning',
    };
  }

  if (isThrottlerException(exception)) {
    return {
      httpStatus: HttpStatus.TOO_MANY_REQUESTS,
      code: ErrorCodes.CLIENT_RATE_LIMITED,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (exception instanceof NotFoundException) {
    return {
      httpStatus: HttpStatus.NOT_FOUND,
      code: ErrorCodes.CLIENT_AUTH_REQUIRED,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (getErrorName(exception) === 'FetchError') {
    return {
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ErrorCodes.EXTERNAL_SERVICE_ERROR,
      message: 'Service temporarily unavailable',
      logLevel: 'warning',
    };
  }

  if (exception instanceof UnauthorizedException) {
    return {
      httpStatus: HttpStatus.UNAUTHORIZED,
      code: ErrorCodes.CLIENT_AUTH_REQUIRED,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (exception instanceof ConflictException) {
    return {
      httpStatus: HttpStatus.CONFLICT,
      code: ErrorCodes.BUSINESS_DATA_CONFLICT,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: 'warning',
    };
  }

  if (exception instanceof UnprocessableEntityException) {
    const rawCause = exception.cause;
    const code = isValidErrorCode(rawCause) ? rawCause : ErrorCodes.SYSTEM_INTERNAL_ERROR;
    // 业务预期的 422（数据冲突、业务规则）记 warning；其他 cause 视为未预期，记 error
    const warnCodes: ErrorCodeValue[] = [ErrorCodes.DATA_VERSION_MISMATCH, ErrorCodes.BUSINESS_RULE_VIOLATION];
    return {
      httpStatus: HttpStatus.UNPROCESSABLE_ENTITY,
      code,
      message: exception.message,
      errors: getResponseMessage(exception.getResponse()),
      logLevel: warnCodes.includes(code) ? 'warning' : 'error',
    };
  }

  // 注意：HttpException 分支必须放在最后。BadRequest / Unauthorized / NotFound / Conflict /
  // Throttler / UnprocessableEntity 都继承自 HttpException，提前匹配会吃掉它们的细分 code 映射。
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const responseBody = exception.getResponse();
    const responseMessage = getResponseMessage(responseBody);
    const message: string =
      typeof responseBody === 'string'
        ? responseBody
        : typeof responseMessage === 'string'
          ? responseMessage
          : exception.message;

    if (!isServerError(status)) {
      return {
        httpStatus: status,
        code: ErrorCodes.CLIENT_INPUT_ERROR,
        message,
        errors: typeof responseBody === 'object' ? responseMessage : undefined,
        logLevel: 'warning',
      };
    }

    // 5xx HttpException：调用方负责触发 Sentry
    const body = typeof responseBody === 'object' ? (responseBody as Record<string, unknown>) : {};
    return {
      httpStatus: status,
      code: typeof body.code === 'string' ? body.code : ErrorCodes.SYSTEM_INTERNAL_ERROR,
      message: typeof body.message === 'string' ? body.message : 'Internal server error, please try again later',
      logLevel: 'error',
    };
  }

  return null;
}
