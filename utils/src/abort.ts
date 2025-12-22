/**
 * Abort 相关工具函数
 */

/**
 * 尽可能从第三方错误对象中提取"中断"信号。
 * - 支持 AbortError
 * - 支持 message 中包含 aborted/abort_signal/canceled 的情况
 * - 支持直接传递字符串
 */
export function extractAbortReason(err: unknown): string | null {
  if (!err) return null;

  const normalize = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return normalize(err.message) ?? 'abort_signal';
    }
    const message = err.message ? err.message.toLowerCase() : '';
    if (message.includes('aborted') || message.includes('abort signal') || message.includes('canceled')) {
      return normalize(err.message) ?? 'abort_signal';
    }
    if (err.cause) {
      const fromCause = extractAbortReason(err.cause);
      if (fromCause) return fromCause;
    }
    return null;
  }

  if (typeof err === 'string') {
    const normalized = err.toLowerCase();
    if (normalized.includes('abort') || normalized.includes('canceled')) {
      return normalize(err) ?? 'abort_signal';
    }
    return null;
  }

  if (typeof err === 'object') {
    try {
      const stringified = JSON.stringify(err);
      return extractAbortReason(stringified);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 创建 AbortError
 */
export function createAbortError(reason?: string): Error {
  const error = new Error(reason ?? 'abort_signal');
  error.name = 'AbortError';
  return error;
}
