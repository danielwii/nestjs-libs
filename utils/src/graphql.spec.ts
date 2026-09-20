import { Oops } from '@app/nest/exceptions/oops';

import { CursorUtils } from './graphql';

import { describe, expect, it } from 'bun:test';

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected callback to throw');
}

describe('CursorUtils.decodeCursor', () => {
  it('preserves the canonical Validation error emitted for a malformed cursor', () => {
    const cursor = Buffer.from('only-one-part').toString('base64');

    const error = captureThrown(() => CursorUtils.decodeCursor(cursor));

    expect(error).toBeInstanceOf(Oops.Block);
    if (!(error instanceof Oops.Block)) throw new Error('Expected Oops.Block');
    expect(error.httpStatus).toBe(400);
    expect(error.userMessage).toBe('Invalid cursor format');
    expect(error.internalDetails).toBe(`cursor="${cursor}"`);
  });
});

describe('CursoredRequestInput', () => {
  it('registers whitelist metadata for first and after when class-validator is present', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cv = require('class-validator') as {
      getMetadataStorage: () => {
        getTargetValidationMetadatas: (
          target: Function, // eslint-disable-line @typescript-eslint/no-unsafe-function-type
          schema: string,
          always: boolean,
          strict: boolean,
        ) => Array<{ propertyName: string }>;
      };
    };
    const { CursoredRequestInput } = require('./graphql');
    const storage = cv.getMetadataStorage();
    const metadatas = storage.getTargetValidationMetadatas(CursoredRequestInput, '', false, false);
    const propertyNames = metadatas.map((m) => m.propertyName);
    expect(propertyNames).toContain('first');
    expect(propertyNames).toContain('after');
  });
});
