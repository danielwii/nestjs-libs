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
