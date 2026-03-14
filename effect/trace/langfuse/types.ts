/**
 * Langfuse 契约类型定义
 *
 * 参考: https://langfuse.com/docs/integrations/opentelemetry
 */

/** Trace 元数据（整个 trace 共享） */
export interface TraceMetadata {
  name?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
}

/** Observation 元数据（单个 span） */
export interface ObservationMetadata {
  input?: unknown;
  output?: unknown;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
  statusMessage?: string;
  type?: 'span' | 'generation' | 'tool' | 'chain';
}
