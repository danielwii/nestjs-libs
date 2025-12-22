/**
 * 对敏感信息进行mask处理，保留前后若干位，中间用*号替代
 * @param secret 原始密钥字符串
 * @param options 可选，前后保留位数和mask长度
 * @returns mask后的字符串
 */
export function maskSecret(
  secret: string,
  options?: { prefix?: number; suffix?: number; maskLength?: number },
): string {
  if (!secret) return '';
  const prefix = options?.prefix ?? 2;
  const suffix = options?.suffix ?? 3;
  const maskLength = options?.maskLength ?? Math.max(secret.length - prefix - suffix, 4);
  if (secret.length <= prefix + suffix) return '*'.repeat(secret.length);
  return secret.slice(0, prefix) + '*'.repeat(maskLength) + secret.slice(secret.length - suffix);
}
