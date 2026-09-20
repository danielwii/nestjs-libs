import { Oops } from '@app/nest/exceptions/oops';

import { CursoredRequestInput, cursoredRequestSchema, CursorUtils } from './graphql';

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
  it('instantiates with default values', () => {
    const input = new CursoredRequestInput();
    expect(input.first).toBe(20);
    expect(input.after).toBeUndefined();
  });

  it('binds cursoredRequestSchema as static schema', () => {
    expect(CursoredRequestInput.schema).toBe(cursoredRequestSchema);
    const parsedDefault = cursoredRequestSchema.parse({});
    expect(parsedDefault.first).toBe(20);
    expect(parsedDefault.after).toBeUndefined();

    const parsedCustom = cursoredRequestSchema.parse({ first: 50, after: 'cursor-token' });
    expect(parsedCustom.first).toBe(50);
    expect(parsedCustom.after).toBe('cursor-token');
  });
});
