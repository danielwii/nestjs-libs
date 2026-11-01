import { describeError, describeErrorParts } from '@app/utils/describe-error';

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
    if (meta.input !== undefined) {
      const serialized = safeSerialize(meta.input);
      if (serialized) span.setAttribute('langfuse.trace.input', serialized);
    }
    if (meta.output !== undefined) {
      const serialized = safeSerializeOutput(meta.output);
      if (serialized) span.setAttribute('langfuse.trace.output', serialized);
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
   * 设置 Trace 输出（通常在完成时设置）
   */
  static setTraceOutput(span: Span, output: unknown): void {
    const serialized = safeSerializeOutput(output);
    if (serialized) span.setAttribute('langfuse.trace.output', serialized);
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
   * 在 span 上记录异常事件。只写 `describeError` 的内容（类名、错误码、cause 类名），
   * 不写 message / stack：它们取决于抛错的人，可能带请求里的文字。返回这段描述，供状态消息使用。
   */
  static recordException(span: Span, error: unknown): string {
    const description = describeError(error);
    span.recordException({ name: describeErrorParts(error).name, message: description });
    return description;
  }

  /**
   * 标记 span 错误
   */
  static error(span: Span, error: unknown, observation?: ObservationMetadata): void {
    const description = this.recordException(span, error);
    this.setObservation(span, { ...observation, level: 'ERROR', statusMessage: description });
    span.setStatus({ code: SpanStatusCode.ERROR, message: description });
  }
}
