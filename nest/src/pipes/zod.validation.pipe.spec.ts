import { Oops } from '@app/nest/exceptions/oops';
import { isOopsError } from '@app/nest/exceptions/oops-error';

import { StandardValidationPipe, ZodValidationPipe } from './zod.validation.pipe';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@standard-schema/spec';

describe('ZodValidationPipe & StandardValidationPipe', () => {
  it('should export StandardValidationPipe as alias to ZodValidationPipe', () => {
    expect(StandardValidationPipe).toBe(ZodValidationPipe);
  });

  describe('with native Zod schema (Standard Schema compliant)', () => {
    const schema = z.object({
      name: z.string().min(3),
      age: z.number().min(18),
    });
    const pipe = new ZodValidationPipe(schema);

    it('should transform and return valid data', async () => {
      const input = { name: 'Daniel', age: 25 };
      const output = await pipe.transform(input);
      expect(output).toEqual(input);
    });

    it('should throw Oops.Validation on invalid data with issues and message', async () => {
      const input = { name: 'Da', age: 16 };
      try {
        await pipe.transform(input);
        expect().fail('Should have thrown Oops.Validation');
      } catch (err) {
        expect(isOopsError(err)).toBe(true);
        expect(err instanceof Oops.Block).toBe(true);
        const oops = err as any;
        expect(oops.userMessage).toContain('name');
        expect(typeof oops.internalDetails).toBe('string');
        expect(oops.internalDetails).toContain('>=3');
      }
    });
  });

  describe('with custom mock StandardSchemaV1 implementation', () => {
    const mockStandardSchema: StandardSchemaV1<{ count: number }, { count: number }> = {
      '~standard': {
        version: 1,
        vendor: 'mock',
        validate: async (val: unknown) => {
          if (typeof val === 'object' && val !== null && 'count' in val && typeof (val as any).count === 'number') {
            return { value: val as { count: number } };
          }
          return {
            issues: [
              {
                message: 'Expected positive number',
                path: ['count'],
              },
            ],
          };
        },
      },
    };

    const pipe = new StandardValidationPipe(mockStandardSchema);

    it('should validate using ~standard protocol on success', async () => {
      const result = await pipe.transform({ count: 42 });
      expect(result).toEqual({ count: 42 });
    });

    it('should throw Oops.Validation with path-formatted message on failure', async () => {
      try {
        await pipe.transform({ count: 'invalid' });
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isOopsError(err)).toBe(true);
        const oops = err as any;
        expect(oops.userMessage).toBe('[count] Expected positive number');
        expect(oops.internalDetails).toContain('Expected positive number');
      }
    });
  });

  describe('with legacy non-standard parse() object', () => {
    const legacySchema = {
      parse: (val: unknown) => {
        if (val === 'valid') return 'OK';
        throw new Error('Invalid legacy payload');
      },
    };

    const pipe = new ZodValidationPipe(legacySchema);

    it('should pass with valid data', async () => {
      const result = await pipe.transform('valid');
      expect(result).toBe('OK');
    });

    it('should fallback to Oops.Validation on throw', async () => {
      try {
        await pipe.transform('invalid');
        expect().fail('Should have thrown');
      } catch (err) {
        expect(isOopsError(err)).toBe(true);
        const oops = err as any;
        expect(oops.userMessage).toBe('Validation failed');
        expect(oops.internalDetails).toBe('Invalid legacy payload');
      }
    });
  });
});
