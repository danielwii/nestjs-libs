import { Oops } from '../exceptions/oops';
import { isExpectedOopsError } from './logger.interceptor';

import '../exceptions/oops-factories';

import { describe, expect, it } from 'bun:test';

describe('isExpectedOopsError', () => {
  it('returns true for expected non-fatal Oops', () => {
    expect(isExpectedOopsError(Oops.Validation('nope'))).toBe(true);
  });

  it('returns true for Oops.Block 4xx', () => {
    expect(isExpectedOopsError(Oops.Block.Unauthorized())).toBe(true);
    expect(isExpectedOopsError(Oops.Block.Forbidden())).toBe(true);
    expect(isExpectedOopsError(Oops.Block.NotFound('User'))).toBe(true);
  });

  it('returns false for Oops.Panic 5xx', () => {
    expect(isExpectedOopsError(Oops.Panic.Database('x'))).toBe(false);
    expect(isExpectedOopsError(Oops.Panic.ExternalService('Redis'))).toBe(false);
  });

  it('returns false for plain Error / plain shape / primitives', () => {
    expect(isExpectedOopsError(new Error('something broke'))).toBe(false);
    expect(isExpectedOopsError({ httpStatus: 422 })).toBe(false);
    expect(isExpectedOopsError(null)).toBe(false);
    expect(isExpectedOopsError(undefined)).toBe(false);
    expect(isExpectedOopsError('string error')).toBe(false);
    expect(isExpectedOopsError(42)).toBe(false);
  });
});
