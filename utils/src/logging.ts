import { onelineStack } from './error';

import * as process from 'node:process';
import util from 'node:util';

import { instanceToPlain } from 'class-transformer';
import JSON5 from 'json5';
import * as _ from 'radash';

/**
 * 主要用于日志中复杂数据结构的打印
 * @param strings
 * @param values
 */
export function f(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = '';

  for (let i = 0; i < strings.length; i++) {
    result += strings[i] ?? '';
    result += values[i] !== undefined ? r(values[i]) : '';
  }

  return result;
}

export function r(o: unknown): string {
  if (o instanceof Error) {
    if (process.env.NODE_ENV === 'production') {
      return JSON5.stringify({ name: o.name, message: o.message, stack: onelineStack(o.stack) });
    }
    // dev: message + stack trace (dim), custom Error name shown if not generic 'Error'
    const prefix = o.name !== 'Error' ? `[${o.name}] ` : '';
    const stack = o.stack
      ? '\n' +
        o.stack
          .split('\n')
          .slice(1) // skip first line (redundant with message)
          .map((line) => `\x1b[2m${line}\x1b[0m`) // dim
          .join('\n')
      : '';
    return `${prefix}${o.message}${stack}`;
  }

  // 原始类型：prod 直接 String，dev 加类型颜色（不加引号）
  if (o === null || o === undefined) {
    return process.env.NODE_ENV === 'production' || process.env.NO_COLOR ? String(o) : `\x1b[2m${String(o)}\x1b[0m`;
  }
  if (typeof o !== 'object') {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- 日志场景：unknown 窄化后的原始类型转字符串是安全的
    const s = String(o);
    if (process.env.NODE_ENV === 'production' || process.env.NO_COLOR) return s;
    if (typeof o === 'number' || typeof o === 'boolean') return `\x1b[33m${s}\x1b[0m`; // yellow
    if (typeof o === 'string') return o.includes('\x1b[') ? o : `\x1b[36m${o}\x1b[0m`; // cyan, skip if already colored
    return s;
  }

  // 对象和数组都需要格式化
  try {
    const value = instanceToPlain(o);
    return process.env.NODE_ENV === 'production' ? JSON5.stringify(value) : inspect(value);
  } catch {
    return inspect(o);
  }
}

export function inspect(o: unknown, options: util.InspectOptions = { colors: true, depth: 5 }): string {
  const colors = !process.env.NO_COLOR;
  return process.env.NODE_ENV === 'production'
    ? util.inspect(o, { breakLength: Infinity, ...options, colors })
    : util.inspect(o, { ...options, colors });
}
