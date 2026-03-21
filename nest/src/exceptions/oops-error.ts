import type { ErrorCodeValue } from './error-codes';

/**
 * Oops 异常基类
 *
 * 所有业务异常的抽象基类，提供：
 * - 统一的错误码体系（errorCode + oopsCode）
 * - 用户友好消息与内部详情分离
 * - isFatal() 判断是否需要告警
 *
 * 子类：
 * - Oops: 422 业务规则拒绝，不触发 Sentry
 * - Oops.Block: 4xx 请求被拦截（认证/权限/不存在）
 * - Oops.Panic: 500 系统故障，触发 Sentry
 */
export abstract class OopsError extends Error {
  /** HTTP 状态码 */
  abstract readonly httpStatus: number;

  /** 错误码维度 (0x0101 等) */
  abstract readonly errorCode: ErrorCodeValue;

  /** 细节业务码 (US01, LM01 等) */
  abstract readonly oopsCode: string;

  /** 用户友好消息（返回给客户端） */
  abstract readonly userMessage: string;

  /** 内部详情（仅日志，不返回客户端） */
  readonly internalDetails?: string;

  /** 服务提供者标识（用于追踪远程服务错误来源） */
  readonly provider?: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }

  /** 致命异常（500+）应触发 Sentry 告警 */
  isFatal(): boolean {
    return this.httpStatus >= 500;
  }

  /** 组合错误码：{维度码}{细节码} */
  getCombinedCode(): string {
    return `${this.errorCode}${this.oopsCode}`;
  }

  /** 内部调试信息（优先 internalDetails，降级到 message） */
  getInternalDetails(): string {
    return this.internalDetails ?? this.message;
  }
}
