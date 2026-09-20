import { onelineStack } from './error';

import * as process from 'node:process';
import util from 'node:util';

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
    const value = toPlain(o);
    return process.env.NODE_ENV === 'production' ? JSON5.stringify(value) : inspect(value);
  } catch {
    return inspect(o);
  }
}

interface CtStorage {
  findExcludeMetadata?: (
    target: unknown,
    propertyName: string,
  ) => { options?: { toPlainOnly?: boolean; toClassOnly?: boolean } } | undefined;
  findExposeMetadata?: (
    target: unknown,
    propertyName: string,
  ) => { options?: { name?: string; toPlainOnly?: boolean; toClassOnly?: boolean } } | undefined;
  getStrategy?: (target: unknown) => 'exposeAll' | 'excludeAll' | undefined;
}

let ctStorage: CtStorage | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const storageModule = require('class-transformer/cjs/storage') as { defaultMetadataStorage?: CtStorage };
  ctStorage = storageModule.defaultMetadataStorage;
} catch {
  // class-transformer 未安装
}

const MAX_TO_PLAIN_DEPTH = 15;

/**
 * 将 Class 实例或复杂对象安全转换为 plain object，去除函数属性；若遇循环引用则交由 inspect 处理
 */
export function toPlain(
  obj: unknown,
  depth = 0,
  activeStack = new Set<unknown>(),
  memo = new Map<unknown, unknown>(),
): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date || obj instanceof RegExp) return obj;

  if (depth >= MAX_TO_PLAIN_DEPTH) {
    return Array.isArray(obj) || obj instanceof Set ? '[Array]' : '[Object]';
  }

  if (activeStack.has(obj)) {
    throw new Error('Circular structure detected');
  }

  if (memo.has(obj)) {
    return memo.get(obj);
  }

  activeStack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const arr: unknown[] = [];
      memo.set(obj, arr);
      for (const item of obj) {
        arr.push(toPlain(item, depth + 1, activeStack, memo));
      }
      return arr;
    }

    if (obj instanceof Set) {
      const arr: unknown[] = [];
      memo.set(obj, arr);
      for (const item of obj) {
        arr.push(toPlain(item, depth + 1, activeStack, memo));
      }
      return arr;
    }

    if (obj instanceof Map) {
      const plainMap: Record<string, unknown> = {};
      memo.set(obj, plainMap);
      for (const [key, value] of obj.entries()) {
        plainMap[String(key)] = toPlain(value, depth + 1, activeStack, memo);
      }
      return plainMap;
    }

    const cls = obj.constructor;
    const isClassInstance = cls !== Object && cls !== Array;
    const strategy = isClassInstance && ctStorage?.getStrategy ? ctStorage.getStrategy(cls) : undefined;

    const plain: Record<string, unknown> = {};
    memo.set(obj, plain);
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'function') continue;

      if (isClassInstance && ctStorage) {
        const exposeMeta = ctStorage.findExposeMetadata?.(cls, key);
        const excludeMeta = ctStorage.findExcludeMetadata?.(cls, key);

        // 若标注 toClassOnly: true，则在 toPlain (classToPlain) 序列化中绝不暴露
        if (exposeMeta?.options?.toClassOnly === true) continue;

        if (strategy === 'excludeAll') {
          if (!exposeMeta) continue;
        } else if (excludeMeta && excludeMeta.options?.toClassOnly !== true) {
          continue;
        }

        const outputKey = exposeMeta?.options?.name ?? key;
        plain[outputKey] = toPlain(value, depth + 1, activeStack, memo);
      } else {
        plain[key] = toPlain(value, depth + 1, activeStack, memo);
      }
    }
    return plain;
  } finally {
    activeStack.delete(obj);
  }
}

export function inspect(o: unknown, options: util.InspectOptions = { colors: true, depth: 5 }): string {
  const colors = process.env.NODE_ENV !== 'production' && !process.env.NO_COLOR;
  return process.env.NODE_ENV === 'production'
    ? util.inspect(o, { breakLength: Infinity, ...options, colors })
    : util.inspect(o, { ...options, colors });
}
