/**
 * 业务异常接口
 * 用于 AnyExceptionFilter 处理，避免直接依赖具体实现
 *
 * @deprecated Use OopsError base class instead. This interface is kept for backward compatibility
 * with consumers that haven't migrated to Oops V2 yet.
 * @see OopsError
 */
export interface IBusinessException extends Error {
  /**
   * HTTP 状态码
   */
  readonly httpStatus: number;

  /**
   * 用户友好错误消息
   */
  readonly userMessage: string;

  /**
   * 获取组合错误码（用于生成 i18n key）
   */
  getCombinedCode(): string;

  /**
   * 获取内部调试信息（用于日志）
   */
  getInternalDetails(): string;
}
