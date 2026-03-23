/**
 * Sentry Debug — 错误追踪调试
 *
 * 对标 NestJS SentryDebugController：
 * - 触发测试错误验证 Sentry 连通性
 * - 只允许 localhost 访问（requireLocalOnly）
 *
 * 用法：在 HttpApi 中添加 debug group：
 * ```ts
 * handlers.handle("sentryDebug", () =>
 *   requireLocalOnly.pipe(Effect.flatMap(() => testSentry)),
 * );
 * ```
 */

import { Effect } from 'effect';

/**
 * 触发 Sentry 测试错误
 *
 * 返回 { success, message } 表示结果
 */
export const testSentry = Effect.sync(() => {
  let Sentry: { captureException: (error: unknown) => void };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency, not installed at compile time
    Sentry = require('@sentry/bun');
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dependency, not installed at compile time
      Sentry = require('@sentry/node');
    } catch {
      return { success: false as const, message: '@sentry/bun or @sentry/node not installed' };
    }
  }

  if (!process.env.SENTRY_DSN) {
    return { success: false as const, message: 'SENTRY_DSN not set' };
  }

  const error = new Error(`[Sentry Test] triggered at ${new Date().toISOString()}`);
  Sentry.captureException(error);

  return { success: true as const, message: 'Test error sent to Sentry' };
});
