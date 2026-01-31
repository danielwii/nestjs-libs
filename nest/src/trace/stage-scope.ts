/**
 * Stage Scope - span 生命周期自动管理
 *
 * ## 设计意图
 *
 * 简化 span 的创建、parent 查找、状态设置和结束操作。
 * 适用于"阶段式"流水线，每个阶段是一个独立的 span。
 *
 * ## 三种使用模式
 *
 * ### 1. runStageScope - 异步函数（推荐）
 *
 * 自动管理整个生命周期：创建 → 执行 → 状态 → 结束
 *
 * ```typescript
 * const result = await runStageScope('live', 'stage.0.retrieve', async (span) => {
 *   // 业务逻辑
 *   return { data: 123 };
 * });
 * ```
 *
 * ### 2. openStageScope - 手动管理（复杂场景）
 *
 * 适用于跨多个异步操作、需要 runInContext 的场景
 *
 * ```typescript
 * const scope = openStageScope('live', 'stage.1.response');
 * try {
 *   // runInContext 确保子 span 挂到这个 span 下
 *   const result = await scope.runInContext(() => aiSdk.streamText(...));
 *   LangfuseContract.success(scope.span);
 * } catch (e) {
 *   LangfuseContract.error(scope.span, e);
 * } finally {
 *   scope.end();
 * }
 * ```
 *
 * ### 3. runStageScopeGenerator - 流式响应
 *
 * 返回 generator 和 span，调用者控制何时结束
 *
 * ```typescript
 * const { generator, span } = runStageScopeGenerator('live', 'stream', () => stream());
 * for await (const chunk of generator) { yield chunk; }
 * span.end();
 * ```
 *
 * ## runInContext 的作用
 *
 * 第三方库（如 AI SDK）内部创建的 spans 默认使用 otelContext.active()。
 * 如果不用 runInContext，这些 spans 会变成独立 trace。
 *
 * ```typescript
 * // ❌ 错误：AI SDK 的 spans 变成独立 trace
 * await aiSdk.streamText(...);
 *
 * // ✅ 正确：AI SDK 的 spans 挂到 scope.span 下
 * await scope.runInContext(() => aiSdk.streamText(...));
 * ```
 */
import { resolveParentContext } from './container-span';

import { context as otelContext, SpanStatusCode, trace } from '@opentelemetry/api';

import type { Attributes, Span } from '@opentelemetry/api';

/**
 * 在指定 container 下运行异步函数
 *
 * 自动处理：
 * 1. 查找 parent span（从 container 或 active context）
 * 2. 创建子 span 并设置 attributes
 * 3. 执行函数，捕获异常
 * 4. 设置状态（OK/ERROR）并结束 span
 *
 * @param containerKey - 容器标识（用于查找 parent）
 * @param spanName - span 名称
 * @param fn - 要执行的异步函数
 * @param options - 可选配置（attributes、是否自动设置状态）
 *
 * @example
 * ```typescript
 * await runStageScope('live', 'stage.0.retrieve', async (span) => {
 *   const data = await fetchData();
 *   span.setAttribute('data.count', data.length);
 *   return data;
 * });
 * ```
 */
export async function runStageScope<T>(
  containerKey: string,
  spanName: string,
  fn: (span: Span) => Promise<T>,
  options?: {
    attributes?: Attributes;
    /** 自动设置 OK/ERROR 状态，默认 true */
    autoStatus?: boolean;
  },
): Promise<T> {
  const tracer = trace.getTracer('ai');
  const { context: parentContext } = resolveParentContext(containerKey);

  return tracer.startActiveSpan(spanName, {}, parentContext, async (span) => {
    try {
      if (options?.attributes) {
        span.setAttributes(options.attributes);
      }
      const result = await fn(span);
      if (options?.autoStatus !== false) {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      if (options?.autoStatus !== false) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'error',
        });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Generator 版本 - 用于流式响应
 *
 * 注意：调用者需要在 generator 完成后自己结束 span
 *
 * @example
 * ```typescript
 * const { generator, span } = runStageScopeGenerator('live', 'stream', (s) => {
 *   return streamResponse();
 * });
 *
 * try {
 *   for await (const chunk of generator) {
 *     yield chunk;
 *   }
 *   span.setStatus({ code: SpanStatusCode.OK });
 * } finally {
 *   span.end();
 * }
 * ```
 */
export function runStageScopeGenerator<T, TReturn = void, TNext = unknown>(
  containerKey: string,
  spanName: string,
  factory: (span: Span) => AsyncGenerator<T, TReturn, TNext>,
  options?: { attributes?: Attributes },
): { generator: AsyncGenerator<T, TReturn, TNext>; span: Span } {
  const tracer = trace.getTracer('ai');
  const { context: parentContext } = resolveParentContext(containerKey);

  const span = tracer.startSpan(spanName, {}, parentContext);
  if (options?.attributes) {
    span.setAttributes(options.attributes);
  }

  return {
    generator: factory(span),
    span,
  };
}

/**
 * Scope 句柄 - 手动管理 span 生命周期
 */
export interface StageScope {
  /** 当前 span */
  span: Span;

  /**
   * 在 span 的 context 中运行代码
   *
   * 用途：让第三方库（如 AI SDK）创建的 spans 自动挂到这个 span 下
   *
   * @example
   * ```typescript
   * const result = await scope.runInContext(() => aiSdk.streamText(...));
   * // AI SDK 内部的 spans 会成为 scope.span 的子 span
   * ```
   */
  runInContext: <T>(fn: () => T) => T;

  /**
   * 结束 span（必须调用）
   *
   * @param error - 如传入 error，会设置 ERROR 状态并记录异常
   */
  end: (error?: Error) => void;
}

/**
 * 手动管理的 scope - 适用于复杂场景
 *
 * 适用场景：
 * - 跨多个异步操作
 * - 需要 runInContext 包装第三方调用
 * - 需要在不同位置设置状态和结束
 *
 * @example
 * ```typescript
 * const scope = openStageScope('live', 'stage.1.response');
 *
 * try {
 *   // 在 scope context 中执行，子 span 会正确嵌套
 *   for await (const chunk of scope.runInContext(() => stream())) {
 *     yield chunk;
 *   }
 *   LangfuseContract.setObservation(scope.span, { output: { ... } });
 *   LangfuseContract.success(scope.span);
 * } catch (e) {
 *   LangfuseContract.error(scope.span, e);
 *   throw e;
 * } finally {
 *   scope.end();
 * }
 * ```
 */
export function openStageScope(containerKey: string, spanName: string, attributes?: Attributes): StageScope {
  const tracer = trace.getTracer('ai');
  const { context: parentContext } = resolveParentContext(containerKey);

  const span = tracer.startSpan(spanName, {}, parentContext);
  if (attributes) {
    span.setAttributes(attributes);
  }

  // 创建包含此 span 的 context，用于 runInContext
  const spanContext = trace.setSpan(parentContext, span);

  return {
    span,
    runInContext: <T>(fn: () => T): T => {
      return otelContext.with(spanContext, fn);
    },
    end: (error?: Error) => {
      if (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      // 注意：不自动设置 OK 状态，由调用者通过 LangfuseContract.success() 设置
      span.end();
    },
  };
}
