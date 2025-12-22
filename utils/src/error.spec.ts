import { errorStack, onelineStack } from './error';

import * as process from 'node:process';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

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

    it('should return undefined and warn for non-Error types', () => {
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(errorStack('string error')).toBeUndefined();
      expect(spy).toHaveBeenCalledWith('unresolved error type: string');
      spy.mockRestore();
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
