import { f, inspect, r, toPlain } from './logging';

import * as process from 'node:process';

import { afterEach, describe, expect, it } from 'bun:test';
import JSON5 from 'json5';

describe('logging.utils', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  const ORIGINAL_NO_COLOR = process.env.NO_COLOR;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    process.env.NO_COLOR = ORIGINAL_NO_COLOR;
  });

  describe('f (template tag)', () => {
    it('should correctly format strings and values', () => {
      process.env.NO_COLOR = 'true';
      const name = 'Daniel';
      const age = 18;
      expect(f`Name: ${name}, Age: ${age}`).toBe('Name: Daniel, Age: 18');
    });

    it('should handle undefined values as empty strings', () => {
      const val = undefined;
      expect(f`Value: ${val}`).toBe('Value: ');
    });
  });

  describe('r (formatter)', () => {
    it('should format Error objects in development', () => {
      process.env.NODE_ENV = 'development';
      const error = new Error('test error');
      error.stack = 'Error: test error\n    at Object.<anonymous> (test.js:1:1)';
      const result = r(error);
      expect(result).toContain('test error');
      expect(result).toContain('at Object');
    });

    it('should format Error objects in production', () => {
      process.env.NODE_ENV = 'production';
      const error = new Error('test error');
      error.stack = 'Error: test error\n    at Object.<anonymous> (test.js:1:1)';
      const result = r(error);
      // In some environments, JSON stringification might differ slightly in whitespace or escaping
      const parsed = JSON5.parse(result);
      expect(parsed.name).toBe('Error');
      expect(parsed.message).toBe('test error');
      expect(parsed.stack).toContain('StackTrace');
    });

    it('should format typical objects', () => {
      process.env.NODE_ENV = 'development';
      const obj = { a: 1, b: '2' };
      const result = r(obj);
      expect(result).toContain('a');
      expect(result).toContain('1');
      expect(result).toContain('2');
    });

    it('should format typical objects in production', () => {
      process.env.NODE_ENV = 'production';
      const obj = { a: 1, b: '2' };
      const result = r(obj);
      const parsed = JSON5.parse(result);
      expect(parsed).toEqual({ a: 1, b: '2' });
    });

    it('should preserve Date objects during formatting', () => {
      const date = new Date('2026-01-01T00:00:00.000Z');
      expect(toPlain(date)).toBe(date);

      process.env.NODE_ENV = 'production';
      const result = r({ time: date });
      expect(result).toContain('2026-01-01T00:00:00.000Z');
    });

    it('should preserve Map and Set objects during formatting', () => {
      const set = new Set(['foo', 'bar']);
      const map = new Map<string, unknown>([['key', 'val']]);
      expect(toPlain(set)).toEqual(['foo', 'bar']);
      expect(toPlain(map)).toEqual({ key: 'val' });

      process.env.NODE_ENV = 'production';
      const result = r({ tags: set, dict: map });
      expect(result).toContain('foo');
      expect(result).toContain('bar');
      expect(result).toContain('key');
      expect(result).toContain('val');
    });

    it('should handle non-object/null/array values by stringifying them', () => {
      process.env.NO_COLOR = 'true';
      expect(r(null)).toBe('null');
      expect(r(123)).toBe('123');
      expect(r('hello')).toBe('hello');
      // 数组现在走 inspect 格式化
      expect(r([1, 2, 3])).toContain('1');
      expect(r([1, 2, 3])).toContain('2');
      expect(r([1, 2, 3])).toContain('3');
    });

    it('should handle repeated non-cyclic sibling references without throwing circular error', () => {
      const shared = { id: 1, name: 'shared-entity' };
      const obj = {
        primary: shared,
        secondary: shared,
        list: [shared, shared],
      };

      const plain = toPlain(obj) as typeof obj;
      expect(plain.primary).toEqual({ id: 1, name: 'shared-entity' });
      expect(plain.secondary).toEqual({ id: 1, name: 'shared-entity' });
      expect(plain.list).toEqual([
        { id: 1, name: 'shared-entity' },
        { id: 1, name: 'shared-entity' },
      ]);

      process.env.NODE_ENV = 'production';
      const formatted = r(obj);
      const parsed = JSON5.parse(formatted);
      expect(parsed.primary.name).toBe('shared-entity');
      expect(parsed.secondary.name).toBe('shared-entity');
    });

    it('should fallback to inspect if instanceToPlain fails', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = r(circular);
      // Just check it returns a string containing circular information without crashing
      expect(typeof result).toBe('string');
      expect(result.toLowerCase()).toContain('circular');
    });
  });

  describe('inspect', () => {
    it('should use colors by default if NO_COLOR is not set', () => {
      delete process.env.NO_COLOR;
      const obj = { foo: 'bar' };
      const result = inspect(obj);
      // Check for ANSI color codes
      expect(result).toContain('\x1b[');
    });

    it('should not use colors if NO_COLOR is set', () => {
      process.env.NO_COLOR = 'true';
      const obj = { foo: 'bar' };
      const result = inspect(obj);
      expect(result).not.toContain('\x1b[');
    });

    it('should handle production mode with Infinite breakLength', () => {
      process.env.NODE_ENV = 'production';
      const obj = { long: 'a'.repeat(100) };
      const result = inspect(obj);
      expect(result).not.toContain('\n');
    });

    it('should never emit colors in production', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.NO_COLOR;
      const result = inspect({ foo: 'bar' });

      expect(result).not.toContain('\x1b[');
    });
  });
});
