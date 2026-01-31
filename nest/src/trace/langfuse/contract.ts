import { safeSerialize, safeSerializeOutput } from './serializer';

import { SpanStatusCode } from '@opentelemetry/api';

import type { ObservationMetadata, TraceMetadata } from './types';
import type { Span } from '@opentelemetry/api';

/**
 * Langfuse 契约实现
 *
 * 将业务语义映射到 Langfuse 识别的 span attributes
 *
 * Langfuse Span Attribute Keys:
 * - 'langfuse.trace.name' - trace 名称
 * - 'langfuse.user.id' - 用户 ID
 * - 'langfuse.session.id' - 会话 ID
 * - 'langfuse.observation.input' - 输入（JSON string）
 * - 'langfuse.observation.output' - 输出（JSON string）
 * - 'langfuse.observation.level' - DEBUG | DEFAULT | WARNING | ERROR
 * - 'langfuse.observation.status_message' - 状态消息
 * - 'langfuse.observation.type' - span | generation | tool | chain | ...
 *
 * AI SDK 兼容:
 * - 'ai.telemetry.metadata.userId' - 用户 ID
 * - 'ai.telemetry.metadata.sessionId' - 会话 ID
 * - 'ai.telemetry.metadata.tags' - 标签数组
 * - 'ai.input' - 输入
 * - 'ai.output' - 输出
 */
export class LangfuseContract {
  /**
   * 设置 Trace 元数据（通常在 root span 设置）
   */
  static setTraceMetadata(span: Span, meta: TraceMetadata): void {
    if (meta.name) {
      span.setAttribute('langfuse.trace.name', meta.name);
    }
    if (meta.userId) {
      span.setAttribute('langfuse.user.id', meta.userId);
      span.setAttribute('ai.telemetry.metadata.userId', meta.userId);
    }
    if (meta.sessionId) {
      span.setAttribute('langfuse.session.id', meta.sessionId);
      span.setAttribute('ai.telemetry.metadata.sessionId', meta.sessionId);
    }
    if (meta.tags?.length) {
      span.setAttribute('ai.telemetry.metadata.tags', meta.tags);
    }
  }

  /**
   * 设置 Observation 元数据（单个 span）
   */
  static setObservation(span: Span, meta: ObservationMetadata): void {
    if (meta.input !== undefined) {
      const serialized = safeSerialize(meta.input);
      if (serialized) {
        span.setAttribute('langfuse.observation.input', serialized);
        span.setAttribute('ai.input', serialized);
      }
    }
    if (meta.output !== undefined) {
      const serialized = safeSerializeOutput(meta.output);
      if (serialized) {
        span.setAttribute('langfuse.observation.output', serialized);
        span.setAttribute('ai.output', serialized);
      }
    }
    if (meta.level) {
      span.setAttribute('langfuse.observation.level', meta.level);
    }
    if (meta.statusMessage) {
      span.setAttribute('langfuse.observation.status_message', meta.statusMessage);
    }
    if (meta.type) {
      span.setAttribute('langfuse.observation.type', meta.type);
    }
  }

  /**
   * 标记 span 成功
   */
  static success(span: Span, observation?: ObservationMetadata): void {
    if (observation) {
      this.setObservation(span, { ...observation, level: observation.level ?? 'DEFAULT' });
    }
    span.setStatus({ code: SpanStatusCode.OK });
  }

  /**
   * 标记 span 警告
   */
  static warning(span: Span, message: string, observation?: ObservationMetadata): void {
    this.setObservation(span, { ...observation, level: 'WARNING', statusMessage: message });
    span.setStatus({ code: SpanStatusCode.OK, message });
  }

  /**
   * 标记 span 错误
   */
  static error(span: Span, error: Error, observation?: ObservationMetadata): void {
    span.recordException(error);
    this.setObservation(span, { ...observation, level: 'ERROR', statusMessage: error.message });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
}
