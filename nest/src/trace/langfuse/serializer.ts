/**
 * 安全序列化工具
 *
 * - JSON 序列化
 * - 错误处理（不抛异常）
 */

/**
 * 安全序列化值为 JSON 字符串
 *
 * @param value - 要序列化的值
 * @returns JSON 字符串或 null
 */
export function safeSerialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  try {
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * 安全序列化输出值
 *
 * @param value - 要序列化的值
 * @returns JSON 字符串或 null
 */
export function safeSerializeOutput(value: unknown): string | null {
  return safeSerialize(value);
}
