import { ErrorCodes } from './error-codes';
import { Oops } from './oops';

// ==================== Oops (422) Factories ====================

/** 通用参数验证失败 */
Oops.Validation = function (message: string, details?: string): Oops {
  return new Oops({
    errorCode: ErrorCodes.CLIENT_VALIDATION_FAILED,
    oopsCode: 'GN01',
    userMessage: message,
    internalDetails: details,
  });
};

/** 通用资源未找到 */
Oops.NotFound = function (resource: string, id?: string): Oops {
  return new Oops({
    errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
    oopsCode: 'GN02',
    userMessage: `${resource}不存在`,
    internalDetails: id ? `${resource} not found: ${id}` : `${resource} not found`,
  });
};

/** 外部服务可预期错误（服务回了但拒绝了） */
Oops.ExternalServiceExpected = function (provider: string, details?: string): Oops {
  return new Oops({
    errorCode: ErrorCodes.EXTERNAL_API_UNAVAILABLE,
    oopsCode: 'GN03',
    userMessage: '服务暂时不可用，请稍后重试',
    internalDetails: details ? `[${provider}] ${details}` : `[${provider}] service error`,
    provider,
  });
};

// ==================== Oops.Block (4xx) Factories ====================

/** 未认证 — 401 */
Oops.Block.Unauthorized = function (details?: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 401,
    errorCode: ErrorCodes.CLIENT_AUTH_REQUIRED,
    oopsCode: 'GN04',
    userMessage: '认证失败，请重新登录',
    internalDetails: details,
  });
};

/** 无权限 — 403 */
Oops.Block.Forbidden = function (resource?: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 403,
    errorCode: ErrorCodes.CLIENT_PERMISSION_DENIED,
    oopsCode: 'GN05',
    userMessage: '无权访问',
    internalDetails: resource ? `Forbidden: ${resource}` : undefined,
  });
};

/** 资源不存在 — 404 */
Oops.Block.NotFound = function (resource: string, id?: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 404,
    errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
    oopsCode: 'GN02',
    userMessage: `${resource}不存在`,
    internalDetails: id ? `${resource} not found: ${id}` : `${resource} not found`,
  });
};

/** 资源冲突 — 409 */
Oops.Block.Conflict = function (details: string): Oops.Block {
  return new Oops.Block({
    httpStatus: 409,
    errorCode: ErrorCodes.CLIENT_RESOURCE_CONFLICT,
    oopsCode: 'GN06',
    userMessage: '操作冲突，请重试',
    internalDetails: details,
  });
};

/** 通用限流 — 429 */
Oops.Block.RateLimited = function (resource: string, retryAfterMs?: number): Oops.Block {
  return new Oops.Block({
    httpStatus: 429,
    errorCode: ErrorCodes.CLIENT_RATE_LIMITED,
    oopsCode: 'GN07',
    userMessage: '请求过于频繁，请稍后再试',
    internalDetails: `Rate limited: ${resource}${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ''}`,
  });
};

// ==================== Oops.Block (4xx) — AI/LLM ====================

/** AI 模型限流 — 429 */
Oops.Block.AIModelRateLimited = function (model: string, options?: { cause?: unknown }): Oops.Block {
  return new Oops.Block({
    httpStatus: 429,
    errorCode: ErrorCodes.EXTERNAL_API_QUOTA,
    oopsCode: 'AI02',
    userMessage: 'AI 服务繁忙，请稍后重试',
    internalDetails: `AI model rate limited: ${model}`,
    provider: model,
    cause: options?.cause,
  });
};

// ==================== Oops.Panic (500) — AI/LLM ====================

/** AI 模型调用失败（网络、API 错误等） */
Oops.Panic.AIModelError = function (model: string, error: string, options?: { cause?: unknown }): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
    oopsCode: 'AI01',
    userMessage: '服务暂时不可用，请稍后重试',
    internalDetails: `AI model error (${model}): ${error}`,
    provider: model,
    cause: options?.cause,
  });
};

const AI_FINISH_REASON_MESSAGES: Record<string, string> = {
  'content-filter': '内容被安全过滤器拦截，请调整表达后重试',
  length: '回复超出长度限制，请简化问题后重试',
  error: '回复生成失败，请稍后重试',
};

/**
 * AI 结构化输出生成失败
 *
 * 调用成功但未生成有效的结构化对象。finishReason 来自 Vercel AI SDK：
 * - content-filter: 安全过滤器拦截
 * - length: 输出超出 token 限制
 * - error: 模型内部错误
 * - other/undefined: 未知原因
 */
Oops.Panic.AIObjectGenerationFailed = function (
  model: string,
  finishReason: string,
  partialText?: string,
  options?: { cause?: unknown },
): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
    oopsCode: 'AI04',
    userMessage: AI_FINISH_REASON_MESSAGES[finishReason] ?? `回复生成失败（${finishReason}）`,
    internalDetails: `AI object generation failed [${model}] reason=${finishReason}${partialText ? ` partial=${partialText}` : ''}`,
    provider: model,
    cause: options?.cause,
  });
};

// ==================== Oops.Panic (500) Factories ====================

/** 数据库致命错误 — "系统繁忙" */
Oops.Panic.Database = function (operation: string): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.SYSTEM_DATABASE_ERROR,
    userMessage: '系统繁忙，请稍后重试',
    internalDetails: `Database operation failed: ${operation}`,
  });
};

/** 外部服务不可达 — "服务暂时不可用" */
Oops.Panic.ExternalService = function (service: string, details?: string): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
    userMessage: '服务暂时不可用，请稍后重试',
    internalDetails: `External service error: ${service}${details ? `, ${details}` : ''}`,
    provider: service,
  });
};

/** 配置/初始化错误 — 环境变量缺失或配置不合法 */
Oops.Panic.Config = function (details: string): Oops.Panic {
  return new Oops.Panic({
    errorCode: ErrorCodes.SYSTEM_INTERNAL_ERROR,
    userMessage: '服务配置异常，请联系管理员',
    internalDetails: `Configuration error: ${details}`,
  });
};

// ==================== Type Augmentation ====================

/* eslint-disable @typescript-eslint/no-namespace -- module augmentation requires namespace syntax */
declare module './oops' {
  namespace Oops {
    // Oops (422) factory methods
    function Validation(message: string, details?: string): Oops;
    function NotFound(resource: string, id?: string): Oops;
    function ExternalServiceExpected(provider: string, details?: string): Oops;

    // Block (4xx) factory methods
    namespace Block {
      function Unauthorized(details?: string): Oops.Block;
      function Forbidden(resource?: string): Oops.Block;
      function NotFound(resource: string, id?: string): Oops.Block;
      function Conflict(details: string): Oops.Block;
      function RateLimited(resource: string, retryAfterMs?: number): Oops.Block;
      function AIModelRateLimited(model: string, options?: { cause?: unknown }): Oops.Block;
    }

    // Panic (500) factory methods
    namespace Panic {
      function Database(operation: string): Oops.Panic;
      function ExternalService(service: string, details?: string): Oops.Panic;
      function Config(details: string): Oops.Panic;
      function AIModelError(model: string, error: string, options?: { cause?: unknown }): Oops.Panic;
      function AIObjectGenerationFailed(
        model: string,
        finishReason: string,
        partialText?: string,
        options?: { cause?: unknown },
      ): Oops.Panic;
    }
  }
}
