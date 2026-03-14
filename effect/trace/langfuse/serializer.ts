/**
 * 安全序列化工具 — 不抛异常
 */

export function safeSerialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function safeSerializeOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    if (typeof value === 'string') return value;
    const str = JSON.stringify(value);
    // 截断过长输出（Langfuse attribute 有大小限制）
    return str.length > 10_000 ? `${str.slice(0, 10_000)}...[truncated]` : str;
  } catch {
    return '[unserializable]';
  }
}
