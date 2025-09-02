/**
 * 业务异常接口
 * 用于 AnyExceptionFilter 处理，避免直接依赖具体实现
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
}