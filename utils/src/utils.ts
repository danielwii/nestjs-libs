import { instanceToPlain } from 'class-transformer';
import * as process from 'process';
import JSON from 'json5';
import _ from 'lodash';

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
  if (!_.isObjectLike(o)) return o;
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

export function onelineStack(stack: string) {
  return (
    'StackTrace: ' +
    (process.env.NODE_ENV === 'production'
      ? stack
          ?.replace(/^.*[\\/]node_modules[\\/].*$/gm, '')
          .split('\n')
          .slice(0, 2)
          .join('\\n')
      : stack)
  );
}
