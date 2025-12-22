export type ApiRes<Data = unknown> =
  | {
      success: true;
      message?: string;
      data?: Data;
      meta?: Record<string, unknown>;
    }
  | {
      success: false;
      message: string;
      code?: string;
      errors?: unknown;
    };

export const ApiRes = {
  success: <Data>(
    data?: Data,
    message?: string,
    meta?: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): ApiRes<Data> => ({
    success: true as const,
    message,
    data,
    meta,
    ...extra,
  }),

  ok: (message: string, meta?: Record<string, unknown>): ApiRes => ({
    success: true as const,
    message,
    meta,
  }),

  /**
   * 业务中尽量不要使用此方法！应该直接抛出异常（throw Oops.xxx()）让 AnyExceptionFilter 处理。
   *
   * 问题：此方法返回 HTTP 200/201 状态码，但 success=false，违反 RESTful 规范。
   *
   * 正确做法：
   * ```typescript
   * // ❌ 错误
   * return ApiRes.failure({ code: '0x0103', message: '认证失败' });
   *
   * // ✅ 正确
   * throw Oops.UserNotFound(userId);
   * // 或
   * throw new BusinessException({ httpStatus: 422, errorCode: '0x0103', ... });
   * ```
   */
  failure: ({ code, message, errors }: { code?: string; message: string; errors?: unknown }): ApiRes<never> => ({
    success: false as const,
    message,
    code,
    errors,
  }),
};
