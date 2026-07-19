import { Oops } from '../exceptions/oops';
import { isOopsBusinessException } from './logger.interceptor';

import '../exceptions/oops-factories';

import { describe, expect, it } from 'bun:test';

describe('isOopsBusinessException', () => {
  it('returns true for Oops (422)', () => {
    expect(isOopsBusinessException(Oops.Validation('nope'))).toBe(true);
  });

  it('returns true for Oops.Block 4xx', () => {
    expect(isOopsBusinessException(Oops.Block.Unauthorized())).toBe(true);
    expect(isOopsBusinessException(Oops.Block.Forbidden())).toBe(true);
    expect(isOopsBusinessException(Oops.Block.NotFound('User'))).toBe(true);
  });

  it('returns false for Oops.Panic 5xx', () => {
    expect(isOopsBusinessException(Oops.Panic.Database('x'))).toBe(false);
    expect(isOopsBusinessException(Oops.Panic.ExternalService('Redis'))).toBe(false);
  });

  it('returns false for plain Error / plain shape / primitives', () => {
    expect(isOopsBusinessException(new Error('something broke'))).toBe(false);
    expect(isOopsBusinessException({ httpStatus: 422 })).toBe(false);
    expect(isOopsBusinessException(null)).toBe(false);
    expect(isOopsBusinessException(undefined)).toBe(false);
    expect(isOopsBusinessException('string error')).toBe(false);
    expect(isOopsBusinessException(42)).toBe(false);
  });
});
