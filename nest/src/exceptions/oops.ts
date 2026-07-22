import { ErrorCodes } from './error-codes';
import { OopsError } from './oops-error';

import type { ErrorCodeValue } from './error-codes';

// ==================== Config Interfaces ====================

interface OopsConfig {
  errorCode: ErrorCodeValue;
  oopsCode: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
  /** 原始错误，保留完整错误链用于调试 */
  cause?: unknown;
}

type BlockHttpStatus = 400 | 401 | 403 | 404 | 408 | 409 | 413 | 415 | 429;
type PanicHttpStatus = 500 | 502 | 503;

interface BlockConfig extends OopsConfig {
  httpStatus: BlockHttpStatus;
}

interface PanicConfig {
  /** Defaults to 500; use 502/503 when preserving upstream dependency failure semantics. */
  httpStatus?: PanicHttpStatus;
  errorCode: ErrorCodeValue;
  oopsCode: string;
  userMessage: string;
  internalDetails?: string;
  provider?: string;
  /** 原始错误，保留完整错误链用于调试 */
  cause?: unknown;
}

type ExternalServicePanicOptions = { cause?: unknown; httpStatus?: PanicHttpStatus };

function requireOopsCode(oopsCode: string): string {
  if (typeof oopsCode !== 'string' || oopsCode.trim().length === 0) {
    throw new TypeError('oopsCode must be a non-empty string');
  }
  return oopsCode;
}

const AI_FINISH_REASON_MESSAGES: Record<string, string> = {
  'content-filter': '内容被安全过滤器拦截，请调整表达后重试',
  length: '回复超出长度限制，请简化问题后重试',
  error: '回复生成失败，请稍后重试',
};

// ==================== Oops (422) ====================

/**
 * 业务逻辑拒绝 — 422 Unprocessable Entity
 *
 * 请求合法，进了门，但业务逻辑说不行。
 * WARN 日志，不触发 Sentry。
 */
class Oops extends OopsError {
  readonly httpStatus = 422 as const;
  readonly errorCode: ErrorCodeValue;
  readonly oopsCode: string;
  readonly userMessage: string;
  override readonly internalDetails?: string;
  override readonly provider?: string;

  constructor(config: OopsConfig) {
    super(config.internalDetails ?? config.userMessage, { cause: config.cause });
    this.errorCode = config.errorCode;
    this.oopsCode = requireOopsCode(config.oopsCode);
    this.userMessage = config.userMessage;
    this.internalDetails = config.internalDetails;
    this.provider = config.provider;
  }
}

// ==================== Namespace (Block + Panic + factories) ====================
// eslint-disable-next-line @typescript-eslint/no-namespace -- class+namespace merging for Oops.Block / Oops.Panic
namespace Oops {
  /**
   * 请求被拦截 — 4xx
   *
   * 门口就被挡了：认证失败、无权限、资源不存在、状态冲突。
   * WARN 日志，不触发 Sentry。
   */
  export class Block extends OopsError {
    readonly httpStatus: BlockHttpStatus;
    readonly errorCode: ErrorCodeValue;
    readonly oopsCode: string;
    readonly userMessage: string;
    override readonly internalDetails?: string;
    override readonly provider?: string;

    constructor(config: BlockConfig) {
      super(config.internalDetails ?? config.userMessage, { cause: config.cause });
      this.httpStatus = config.httpStatus;
      this.errorCode = config.errorCode;
      this.oopsCode = requireOopsCode(config.oopsCode);
      this.userMessage = config.userMessage;
      this.internalDetails = config.internalDetails;
      this.provider = config.provider;
    }
  }

  /**
   * 系统故障 — 5xx server / upstream failure
   *
   * 大楼停电了：DB 挂了、外部服务不可达、配置缺失。
   * 缺省 500；上游依赖失败可显式标 502/503。
   * ERROR 日志，触发 Sentry。
   */
  export class Panic extends OopsError {
    readonly httpStatus: PanicHttpStatus;
    readonly errorCode: ErrorCodeValue;
    readonly oopsCode: string;
    readonly userMessage: string;
    override readonly internalDetails?: string;
    override readonly provider?: string;

    constructor(config: PanicConfig) {
      super(config.internalDetails ?? config.userMessage, { cause: config.cause });
      this.httpStatus = config.httpStatus ?? 500;
      this.errorCode = config.errorCode;
      this.oopsCode = requireOopsCode(config.oopsCode);
      this.userMessage = config.userMessage;
      this.internalDetails = config.internalDetails;
      this.provider = config.provider;
    }
  }

  // ==================== Generic Oops Factories ====================

  /** 外部请求参数验证失败 — 400 */
  export function Validation(message: string, details?: string): Oops.Block {
    return new Oops.Block({
      httpStatus: 400,
      errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
      oopsCode: 'GN01',
      userMessage: message,
      internalDetails: details,
    });
  }

  /** 外部服务可预期错误（服务回了但拒绝了） */
  export function ExternalServiceExpected(provider: string, details?: string): Oops {
    return new Oops({
      errorCode: ErrorCodes.EXTERNAL_API_UNAVAILABLE,
      oopsCode: 'GN03',
      userMessage: '服务暂时不可用，请稍后重试',
      internalDetails: details ? `[${provider}] ${details}` : `[${provider}] service error`,
      provider,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-namespace -- factory namespace merged onto Oops.Block
  export namespace Block {
    /** 未认证 — 401 */
    export function Unauthorized(details?: string): Oops.Block {
      return new Oops.Block({
        httpStatus: 401,
        errorCode: ErrorCodes.CLIENT_AUTH_REQUIRED,
        oopsCode: 'GN04',
        userMessage: '认证失败，请重新登录',
        internalDetails: details,
      });
    }

    /** 无权限 — 403 */
    export function Forbidden(resource?: string): Oops.Block {
      return new Oops.Block({
        httpStatus: 403,
        errorCode: ErrorCodes.CLIENT_PERMISSION_DENIED,
        oopsCode: 'GN05',
        userMessage: '无权访问',
        internalDetails: resource ? `Forbidden: ${resource}` : undefined,
      });
    }

    /** 资源不存在 — 404 */
    export function NotFound(resource: string, id?: string): Oops.Block {
      return new Oops.Block({
        httpStatus: 404,
        errorCode: ErrorCodes.CLIENT_INPUT_ERROR,
        oopsCode: 'GN02',
        userMessage: `${resource}不存在`,
        internalDetails: id ? `${resource} not found: ${id}` : `${resource} not found`,
      });
    }

    /** 资源冲突 — 409 */
    export function Conflict(details: string): Oops.Block {
      return new Oops.Block({
        httpStatus: 409,
        errorCode: ErrorCodes.CLIENT_RESOURCE_CONFLICT,
        oopsCode: 'GN06',
        userMessage: '操作冲突，请重试',
        internalDetails: details,
      });
    }

    /** 通用限流 — 429 */
    export function RateLimited(resource: string, retryAfterMs?: number): Oops.Block {
      return new Oops.Block({
        httpStatus: 429,
        errorCode: ErrorCodes.CLIENT_RATE_LIMITED,
        oopsCode: 'GN07',
        userMessage: '请求过于频繁，请稍后再试',
        internalDetails: `Rate limited: ${resource}${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ''}`,
      });
    }

    /** AI 模型限流 — 429 */
    export function AIModelRateLimited(model: string, options?: { cause?: unknown }): Oops.Block {
      return new Oops.Block({
        httpStatus: 429,
        errorCode: ErrorCodes.EXTERNAL_API_QUOTA,
        oopsCode: 'AI02',
        userMessage: 'AI 服务繁忙，请稍后重试',
        internalDetails: `AI model rate limited: ${model}`,
        provider: model,
        cause: options?.cause,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-namespace -- factory namespace merged onto Oops.Panic
  export namespace Panic {
    /** AI 模型调用失败（网络、API 错误等） */
    export function AIModelError(model: string, error: string, options?: { cause?: unknown }): Oops.Panic {
      return new Oops.Panic({
        errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
        oopsCode: 'AI01',
        userMessage: '服务暂时不可用，请稍后重试',
        internalDetails: `AI model error (${model}): ${error}`,
        provider: model,
        cause: options?.cause,
      });
    }

    /**
     * AI 结构化输出生成失败
     *
     * 调用成功但未生成有效的结构化对象。finishReason 来自 AI SDK。
     */
    export function AIObjectGenerationFailed(
      model: string,
      finishReason: string,
      partialText?: string,
      options?: { cause?: unknown },
    ): Oops.Panic {
      return new Oops.Panic({
        errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
        oopsCode: 'AI04',
        userMessage: AI_FINISH_REASON_MESSAGES[finishReason] ?? `回复生成失败（${finishReason}）`,
        internalDetails: `AI object generation failed [${model}] reason=${finishReason}${partialText !== undefined ? ` partial=${partialText || '(empty)'}` : ''}`,
        provider: model,
        cause: options?.cause,
      });
    }

    /** 数据库致命错误 — “系统繁忙” */
    export function Database(operation: string, options?: { cause?: unknown }): Oops.Panic {
      return new Oops.Panic({
        errorCode: ErrorCodes.SYSTEM_DATABASE_ERROR,
        oopsCode: 'GN09',
        userMessage: '系统繁忙，请稍后重试',
        internalDetails: `Database operation failed: ${operation}`,
        cause: options?.cause,
      });
    }

    /** 外部服务不可达 — “服务暂时不可用” */
    export function ExternalService(
      service: string,
      details?: string,
      options?: ExternalServicePanicOptions,
    ): Oops.Panic {
      return new Oops.Panic({
        httpStatus: options?.httpStatus,
        errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
        oopsCode: 'GN10',
        userMessage: '服务暂时不可用，请稍后重试',
        internalDetails: `External service error: ${service}${details ? `, ${details}` : ''}`,
        provider: service,
        cause: options?.cause,
      });
    }

    /** 配置/初始化错误 — 环境变量缺失或配置不合法 */
    export function Config(details: string, options?: { cause?: unknown }): Oops.Panic {
      return new Oops.Panic({
        errorCode: ErrorCodes.SYSTEM_CONFIG_ERROR,
        oopsCode: 'GN11',
        userMessage: '服务配置异常，请联系管理员',
        internalDetails: `Configuration error: ${details}`,
        cause: options?.cause,
      });
    }

    /** 内部调用契约/状态不变量被破坏 — 代码缺陷，不得降级成客户端 400 */
    export function Invariant(details: string, options?: { cause?: unknown }): Oops.Panic {
      return new Oops.Panic({
        errorCode: ErrorCodes.SYSTEM_LOGIC_ERROR,
        oopsCode: 'GN08',
        userMessage: '系统内部状态异常，请稍后重试',
        internalDetails: `Invariant violation: ${details}`,
        cause: options?.cause,
      });
    }
  }
}

export { Oops };
export type { OopsConfig, BlockConfig, PanicConfig, BlockHttpStatus, PanicHttpStatus };
