/**
 * Langfuse 契约 — OTel span attribute 映射
 *
 * 将业务语义映射到 Langfuse 识别的 span attributes。
 * 框架无关（纯 OTel API），NestJS 和 Effect 共享同一契约。
 *
 * Langfuse Span Attribute Keys:
 * - 'langfuse.trace.name' / 'langfuse.user.id' / 'langfuse.session.id'
 * - 'langfuse.observation.input' / 'output' / 'level' / 'type'
 * - AI SDK 兼容: 'ai.telemetry.metadata.*' / 'ai.input' / 'ai.output'
 */

import { safeSerialize, safeSerializeOutput } from './serializer';

import { SpanStatusCode } from '@opentelemetry/api';

import type { ObservationMetadata, TraceMetadata } from './types';
import type { Span } from '@opentelemetry/api';

export class LangfuseContract {
  static setTraceMetadata(span: Span, meta: TraceMetadata): void {
    if (meta.name) span.setAttribute('langfuse.trace.name', meta.name);
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
    if (meta.level) span.setAttribute('langfuse.observation.level', meta.level);
    if (meta.statusMessage) span.setAttribute('langfuse.observation.status_message', meta.statusMessage);
    if (meta.type) span.setAttribute('langfuse.observation.type', meta.type);
  }

  static success(span: Span, observation?: ObservationMetadata): void {
    if (observation) this.setObservation(span, { ...observation, level: observation.level ?? 'DEFAULT' });
    span.setStatus({ code: SpanStatusCode.OK });
  }

  static warning(span: Span, message: string, observation?: ObservationMetadata): void {
    this.setObservation(span, { ...observation, level: 'WARNING', statusMessage: message });
    span.setStatus({ code: SpanStatusCode.OK, message });
  }

  static error(span: Span, error: Error, observation?: ObservationMetadata): void {
    span.recordException(error);
    this.setObservation(span, { ...observation, level: 'ERROR', statusMessage: error.message });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
}
