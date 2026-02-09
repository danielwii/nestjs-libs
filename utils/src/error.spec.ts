import { errorStack, getErrorMessage, onelineStack } from './error';

import * as process from 'node:process';

import { afterEach, describe, expect, it } from 'bun:test';

describe('error.utils', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  describe('errorStack', () => {
    it('should return onelineStack for Error instances', () => {
      const error = new Error('test');
      error.stack = 'line1\nline2\nline3';
      expect(errorStack(error)).toBe('StackTrace: line1\nline2\nline3');
    });

    it('should return JSON serialization for plain objects', () => {
      const obj = { code: 502, message: 'JSON error injected into SSE stream' };
      const result = errorStack(obj);
      expect(result).toStartWith('NonErrorObject: ');
      expect(result).toContain('502');
      expect(result).toContain('JSON error injected into SSE stream');
    });

    it('should return type info for non-serializable values', () => {
      expect(errorStack('string error')).toBe('NonErrorObject: "string error"');
      expect(errorStack(42)).toBe('NonErrorObject: 42');
      expect(errorStack(null)).toBe('NonErrorObject: null');
    });

    it('should handle circular references gracefully', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      const result = errorStack(circular);
      expect(result).toBe('NonErrorObject: object');
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error instances', () => {
      expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('should extract message from plain objects with message property', () => {
      const obj = { code: 502, message: 'upstream error' };
      expect(getErrorMessage(obj)).toBe('upstream error');
    });

    it('should JSON.stringify objects without message property', () => {
      const obj = { code: 502, detail: 'no message field' };
      expect(getErrorMessage(obj)).toBe(JSON.stringify(obj));
    });

    it('should convert primitives to string', () => {
      expect(getErrorMessage('string error')).toBe('"string error"');
      expect(getErrorMessage(42)).toBe('42');
    });
  });

  describe('onelineStack', () => {
    it('should return undefined for non-string or empty stacks', () => {
      expect(onelineStack(null)).toBeUndefined();
      expect(onelineStack(undefined)).toBeUndefined();
      expect(onelineStack('')).toBeUndefined();
      expect(onelineStack(123 as unknown as string)).toBeUndefined();
    });

    it('should return original stack in development', () => {
      process.env.NODE_ENV = 'development';
      const stack = 'Error: test\n    at Place (file.js:1:1)';
      expect(onelineStack(stack)).toBe('StackTrace: ' + stack);
    });

    it('should strip node_modules and slice in production', () => {
      process.env.NODE_ENV = 'production';
      const stack = [
        'Error: test',
        '    at UserCode (user.js:1:1)',
        '    at Internal (node_modules/lib/index.js:1:1)',
        '    at OtherCode (other.js:2:2)',
      ].join('\n');
      const result = onelineStack(stack);
      expect(result).toContain('StackTrace: Error: test\n    at UserCode (user.js:1:1)');
      expect(result).not.toContain('node_modules');
      expect(result).not.toContain('OtherCode');
    });
  });
});
