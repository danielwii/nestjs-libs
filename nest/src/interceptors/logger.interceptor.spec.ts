import { isOopsBusinessException } from './logger.interceptor';

import { describe, expect, it } from 'bun:test';

describe('isOopsBusinessException', () => {
  it('returns true for IOopsException with isFatal()=false (BusinessException)', () => {
    const businessException = {
      isFatal: () => false,
      message: '[MG40001] 设备不在线',
    };
    expect(isOopsBusinessException(businessException)).toBe(true);
  });

  it('returns false for IOopsException with isFatal()=true (FatalException)', () => {
    const fatalException = {
      isFatal: () => true,
      message: 'External service error: marsgate',
    };
    expect(isOopsBusinessException(fatalException)).toBe(false);
  });

  it('returns false for plain Error (no isFatal method)', () => {
    expect(isOopsBusinessException(new Error('something broke'))).toBe(false);
  });

  it('returns false for null / undefined / primitives', () => {
    expect(isOopsBusinessException(null)).toBe(false);
    expect(isOopsBusinessException(undefined)).toBe(false);
    expect(isOopsBusinessException('string error')).toBe(false);
    expect(isOopsBusinessException(42)).toBe(false);
  });

  it('returns false when isFatal exists but is not a function', () => {
    expect(isOopsBusinessException({ isFatal: false })).toBe(false);
    expect(isOopsBusinessException({ isFatal: 'not-a-function' })).toBe(false);
  });
});
