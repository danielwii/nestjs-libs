import { instanceToPlain } from 'class-transformer';
import { isObjectType } from 'remeda';
import * as process from 'process';
import JSON from 'json5';

import util from 'node:util';

/**
 * 主要用于日志中复杂数据结构的打印
 * @param strings
 * @param values
 */
export function f(strings: TemplateStringsArray, ...values: any[]): string {
  let result = '';

  for (let i = 0; i < strings.length; i++) {
    // Append the string part
    result += strings[i];
    // Append the processed value part
    result += values[i] !== undefined ? r(values[i]) : '';
  }

  return result;
}

export function withObject<T, R>(o: T, fn: (o: T) => R): R {
  return fn(o);
}

export function r(o: any): string {
  if (!isObjectType(o)) return String(o);
  try {
    const value = instanceToPlain(o);
    return process.env.NODE_ENV === 'production' ? JSON.stringify(value) : inspect(value);
  } catch (e) {
    return inspect(o);
  }
}

export function inspect(o: any, options: util.InspectOptions = { colors: true, depth: 5 }): string {
  const colors = !process.env.NO_COLOR;
  return process.env.NODE_ENV === 'production'
    ? util.inspect(o, { breakLength: Infinity, ...options, colors })
    : util.inspect(o, { ...options, colors });
}

export function onelineStackFromError(e: unknown): string | undefined {
  if (e instanceof Error) {
    return onelineStack(e.stack);
  }
  console.warn(`unresolved error type: ${typeof e}`);
  return undefined;
}

export function onelineStack(stack: string | undefined | null): string | undefined {
  if (!stack || typeof stack !== 'string') {
    return undefined;
  }

  return (
    'StackTrace: ' +
    (process.env.NODE_ENV === 'production'
      ? stack
          .replace(/^.*[\\/]node_modules[\\/].*$/gm, '')
          .split('\n')
          .slice(0, 2)
          .join('\\n')
      : stack)
  );
}

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
