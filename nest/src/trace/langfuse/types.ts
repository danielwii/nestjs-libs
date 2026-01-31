/**
 * Langfuse 契约类型定义
 *
 * 参考: https://langfuse.com/docs/integrations/opentelemetry
 */

/**
 * Trace 元数据（整个 trace 共享）
 */
export interface TraceMetadata {
  /** Trace 名称（如 'agentic.v5', 'agentic.v5a'） */
  name?: string;
  /** 用户 ID */
  userId?: string;
  /** 会话 ID（如 threadId, conversationId） */
  sessionId?: string;
  /** 标签（用于 Langfuse UI 过滤） */
  tags?: string[];
}

/**
 * Observation 元数据（单个 span）
 */
export interface ObservationMetadata {
  /** 输入（会被 JSON 序列化） */
  input?: unknown;
  /** 输出（会被 JSON 序列化） */
  output?: unknown;
  /** 日志级别（影响 Langfuse UI 高亮） */
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
  /** 状态消息 */
  statusMessage?: string;
  /** Observation 类型 */
  type?: 'span' | 'generation' | 'tool' | 'chain' | 'retriever' | 'embedding';
}

/**
 * Span 执行结果（用于 withTelemetrySpan）
 */
export interface SpanResult<T> {
  /** 业务返回值 */
  result: T;
  /** Observation 元数据 */
  observation?: ObservationMetadata;
  /** 额外 attributes */
  attributes?: Record<string, unknown>;
}
