import * as process from 'node:process';

// ============================================================================
// Unknown Error Type Guards & Helpers
// ============================================================================
//
// 设计背景：
// TypeScript 的 catch 块和 Promise rejection 中，error 类型是 unknown。
// 直接使用 `(error as { message?: string })?.message` 虽然能工作，但：
// 1. 类型断言 `as` 不保证运行时安全（error 可能是 null、string、number 等）
// 2. ESLint no-unnecessary-condition 会报警（因为 `as` 后类型"看起来"非空）
//
// 最佳实践（参考 Kent C. Dodds）：
// 使用 Type Guard 函数进行运行时类型检查，让 TypeScript 通过控制流分析收窄类型。
// 这样既类型安全，又不会触发 lint 警告。
//
// 使用示例：
//   const message = getErrorMessage(error);           // 总是返回 string
//   const stack = getErrorStack(error);               // 返回 string | undefined
//   if (hasErrorName(error)) { console.log(error.name); }  // 类型收窄
//
// ============================================================================

/**
 * 检查 unknown 值是否是带 message 属性的对象
 *
 * Type Guard: 如果返回 true，TypeScript 会将 error 收窄为 { message: string }
 */
export function hasErrorMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

/**
 * 检查 unknown 值是否是带 name 属性的对象
 */
export function hasErrorName(error: unknown): error is { name: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as Record<string, unknown>).name === 'string'
  );
}

/**
 * 检查 unknown 值是否是带 status 属性的对象（HTTP 状态码）
 */
export function hasErrorStatus(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as Record<string, unknown>).status === 'number'
  );
}

/**
 * 检查 unknown 值是否有 getResponse 方法（NestJS HttpException）
 */
export function hasGetResponse(error: unknown): error is { getResponse: () => unknown } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'getResponse' in error &&
    typeof (error as Record<string, unknown>).getResponse === 'function'
  );
}

/**
 * 安全地从 unknown error 中提取 message
 *
 * @returns 如果有 message 属性返回它，否则将整个 error 转为字符串
 */
export function getErrorMessage(error: unknown): string {
  if (hasErrorMessage(error)) return error.message;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 安全地从 unknown error 中提取 name
 */
export function getErrorName(error: unknown): string | undefined {
  if (hasErrorName(error)) return error.name;
  if (error instanceof Error) return error.name;
  return undefined;
}

/**
 * 安全地从 unknown error 中提取 status
 */
export function getErrorStatus(error: unknown, fallback = 500): number {
  if (hasErrorStatus(error)) return error.status;
  return fallback;
}

/**
 * 安全地调用 NestJS exception 的 getResponse()
 */
export function getExceptionResponse(error: unknown): unknown {
  if (hasGetResponse(error)) return error.getResponse();
  return undefined;
}

/**
 * 从 getResponse() 结果中提取 message（可能是字符串或对象）
 */
export function getResponseMessage(response: unknown): unknown {
  if (typeof response === 'object' && response !== null && 'message' in response) {
    return (response as Record<string, unknown>).message;
  }
  return undefined;
}

export function errorStack(e: unknown): string | undefined {
  if (e instanceof Error) {
    return onelineStack(e.stack);
  }
  console.warn(`unresolved error type: ${typeof e}`);
  return undefined;
}

export function onelineStack(stack: string | undefined | null): string | undefined {
  if (!stack || typeof stack !== 'string') {
    return undefined;
  }

  return (
    'StackTrace: ' +
    (process.env.NODE_ENV === 'production'
      ? stack
          .replace(/^.*[\\/]node_modules[\\/].*$/gm, '')
          .split('\n')
          .slice(0, 2)
          .join('\n')
      : stack)
  );
}
