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

  if (typeof o !== 'object' || o === null || Array.isArray(o)) return String(o);
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
