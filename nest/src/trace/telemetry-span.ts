import { LangfuseContract } from './langfuse/contract';
import { RequestContext } from './request-context';

import { context as otelContext, trace } from '@opentelemetry/api';

import type { SpanResult, TraceMetadata } from './langfuse/types';
import type { Span, SpanContext } from '@opentelemetry/api';

/**
 * 安全设置 span attributes
 * 对象类型使用 JSON.stringify，其他类型使用原始值
 */
function setSpanAttributes(span: Span, attributes: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      span.setAttribute(key, value);
    } else if (Array.isArray(value)) {
      // OTel 支持 string[] | number[] | boolean[]
      span.setAttribute(key, JSON.stringify(value));
    } else {
      span.setAttribute(key, JSON.stringify(value));
    }
  }
}

export interface TelemetrySpanOptions<T> {
  /** Span 名称（如 'stage.0.retrieve', 'stage.1.response'） */
  name: string;

  /** Trace 元数据（仅 root span 需要） */
  trace?: TraceMetadata;

  /** 初始 attributes */
  attributes?: Record<string, unknown>;

  /** 父 span context（可选，默认使用 active context） */
  parentContext?: SpanContext;

  /** 执行函数 */
  executor: (span: Span) => Promise<T | SpanResult<T>>;
}

/**
 * 通用的 Telemetry Span 封装
 *
 * 功能：
 * - 自动创建 span 并设置 parent
 * - 自动设置 Langfuse trace/observation 元数据
 * - 自动从 RequestContext 读取 userId/threadId
 * - 自动处理错误和状态
 *
 * 使用示例：
 * ```typescript
 * const result = await withTelemetrySpan({
 *   name: 'stage.0.retrieve',
 *   trace: { name: 'agentic.v5' },  // 仅 root span
 *   executor: async (span) => {
 *     // 业务逻辑
 *     return {
 *       result: data,
 *       observation: { output: data }
 *     };
 *   }
 * });
 * ```
 */
export async function withTelemetrySpan<T>(options: TelemetrySpanOptions<T>): Promise<T> {
  const tracer = trace.getTracer('ai');
  const { name, trace: traceMeta, attributes, parentContext, executor } = options;

  // 确定 parent context
  let activeCtx = otelContext.active();
  if (parentContext) {
    activeCtx = trace.setSpanContext(activeCtx, parentContext);
  }

  return tracer.startActiveSpan(name, {}, activeCtx, async (span) => {
    try {
      // 1. 设置 trace 元数据（从 options 或 RequestContext）
      const effectiveTraceMeta: TraceMetadata = {
        name: traceMeta?.name,
        userId: traceMeta?.userId ?? RequestContext.get<string>('userId'),
        sessionId: traceMeta?.sessionId ?? RequestContext.get<string>('threadId'),
        tags: traceMeta?.tags,
      };

      // 检查是否已设置 trace name（避免重复设置）
      const traceNameAlreadySet = RequestContext.get<boolean>('langfuse.trace.name.set');

      // 仅当有 trace name 且未设置过时设置
      if (effectiveTraceMeta.name && !traceNameAlreadySet) {
        LangfuseContract.setTraceMetadata(span, effectiveTraceMeta);
        RequestContext.set('langfuse.trace.name.set', true);
      } else {
        // 非 root span：只设置 userId/sessionId
        if (effectiveTraceMeta.userId) {
          span.setAttribute('langfuse.user.id', effectiveTraceMeta.userId);
        }
        if (effectiveTraceMeta.sessionId) {
          span.setAttribute('langfuse.session.id', effectiveTraceMeta.sessionId);
        }
      }

      // 2. 设置初始 attributes
      if (attributes) {
        setSpanAttributes(span, attributes);
      }

      // 3. 执行业务逻辑
      const raw = await executor(span);

      // 4. 处理返回值（支持 SpanResult<T> 或直接返回 T）
      let result: T;
      let observation: SpanResult<T>['observation'] | undefined;
      let extraAttrs: SpanResult<T>['attributes'] | undefined;

      if (raw !== null && typeof raw === 'object' && 'result' in raw) {
        const spanResult = raw;
        result = spanResult.result;
        observation = spanResult.observation;
        extraAttrs = spanResult.attributes;
      } else {
        result = raw as T;
      }

      // 5. 设置 observation 和成功状态
      if (extraAttrs) {
        setSpanAttributes(span, extraAttrs);
      }
      LangfuseContract.success(span, observation);

      return result;
    } catch (error) {
      LangfuseContract.error(span, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Generator 版本的 withTelemetrySpan
 * 用于流式响应场景
 *
 * 注意：调用者需要自己负责在 generator 完成后结束 span
 */
export function withTelemetryGenerator<T, TReturn = void>(
  options: Omit<TelemetrySpanOptions<TReturn>, 'executor'> & {
    factory: (span: Span) => AsyncGenerator<T, TReturn>;
  },
): { generator: AsyncGenerator<T, TReturn>; span: Span } {
  const tracer = trace.getTracer('ai');
  const { name, trace: traceMeta, attributes, parentContext, factory } = options;

  let activeCtx = otelContext.active();
  if (parentContext) {
    activeCtx = trace.setSpanContext(activeCtx, parentContext);
  }

  const span = tracer.startSpan(name, {}, activeCtx);

  // 设置 trace 元数据
  const effectiveTraceMeta: TraceMetadata = {
    name: traceMeta?.name,
    userId: traceMeta?.userId ?? RequestContext.get<string>('userId'),
    sessionId: traceMeta?.sessionId ?? RequestContext.get<string>('threadId'),
    tags: traceMeta?.tags,
  };

  const traceNameAlreadySet = RequestContext.get<boolean>('langfuse.trace.name.set');

  if (effectiveTraceMeta.name && !traceNameAlreadySet) {
    LangfuseContract.setTraceMetadata(span, effectiveTraceMeta);
    RequestContext.set('langfuse.trace.name.set', true);
  }

  if (attributes) {
    setSpanAttributes(span, attributes);
  }

  // 返回 generator 和 span，由调用者负责结束 span
  return { generator: factory(span), span };
}

/**
 * Fire-and-forget 版本的 withTelemetrySpan
 * 用于不需要等待结果的场景（如心情分析）
 *
 * 自动捕获错误并记录到 span，不会抛出
 */
export function fireAndForgetSpan<T>(options: TelemetrySpanOptions<T>, onError?: (error: Error) => void): void {
  withTelemetrySpan(options).catch((error: unknown) => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  });
}
