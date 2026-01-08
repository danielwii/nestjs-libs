import { wrapPrototype } from './logger.utils';

import { describe, expect, it, mock } from 'bun:test';

describe('LoggerUtils', () => {
  describe('wrapPrototype', () => {
    it('should append stack trace to message if stack is provided (3 args)', () => {
      const originalFn = mock((..._args: unknown[]) => {});
      const mockFn = {
        name: 'testFn',
        apply: originalFn,
      };

      const wrapped = wrapPrototype(mockFn as unknown as (...args: unknown[]) => unknown);

      const message = 'Test Error';
      const stack = 'Error: something\n    at test.ts:1:1';
      const context = 'TestContext';

      // Logger.error(message, stack, context) calls pass 3 arguments
      (wrapped as (...args: unknown[]) => unknown).call(null, message, stack, context);

      expect(originalFn).toHaveBeenCalledTimes(1);

      // Because wrapPrototype calls prototype.apply(this, args),
      // and mockFn.apply IS originalFn,
      // originalFn is called with (this, argsArray)
      const callArgs = originalFn.mock.calls[0]!;

      // callArgs[1] is the arguments array passed to apply
      const actualArgs = callArgs[1] as unknown[];

      // args[0] should be modified
      expect(actualArgs[0] as string).toContain(message);
      expect(actualArgs[0] as string).toContain('StackTrace:');

      // args[1] should be undefined
      expect(actualArgs[1]).toBeUndefined();

      // args[2] should be context
      expect(actualArgs[2]).toBe(context);
    });

    it('should not modify args if only message is provided', () => {
      const originalFn = mock((..._args: unknown[]) => {});
      const mockFn = {
        name: 'testFn',
        apply: originalFn,
      };

      const wrapped = wrapPrototype(mockFn as unknown as (...args: unknown[]) => unknown);

      const message = 'Test Log';

      (wrapped as (...args: unknown[]) => unknown).call(null, message);

      expect(originalFn).toHaveBeenCalledTimes(1);

      const callArgs = originalFn.mock.calls[0]!;
      const actualArgs = callArgs[1] as unknown[];

      expect(actualArgs[0]).toBe(message);
    });
  });
});
