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
    const errorInfo = {
      name: o.name,
      message: o.message,
      stack: onelineStack(o.stack),
    };
    return process.env.NODE_ENV === 'production' ? JSON5.stringify(errorInfo) : inspect(errorInfo);
  }

  // 原始类型：prod 直接 String，dev 加类型颜色（不加引号）
  if (o === null || o === undefined) {
    return process.env.NODE_ENV === 'production' || process.env.NO_COLOR ? String(o) : `\x1b[2m${o}\x1b[0m`;
  }
  if (typeof o !== 'object') {
    if (process.env.NODE_ENV === 'production' || process.env.NO_COLOR) return String(o);
    if (typeof o === 'number' || typeof o === 'boolean') return `\x1b[33m${o}\x1b[0m`; // yellow
    if (typeof o === 'string') return o.includes('\x1b[') ? o : `\x1b[36m${o}\x1b[0m`; // cyan, skip if already colored
    return String(o);
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
