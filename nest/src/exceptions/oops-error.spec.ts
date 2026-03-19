import { OopsError } from './oops-error';

import { describe, expect, it } from 'bun:test';

describe('OopsError', () => {
  it('should provide isFatal() based on httpStatus', () => {
    class TestOops extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101' as const;
      readonly oopsCode = 'TS01';
      readonly userMessage = 'test';
    }
    class TestPanic extends OopsError {
      readonly httpStatus = 500;
      readonly errorCode = '0x0401' as const;
      readonly oopsCode = 'TS01';
      readonly userMessage = 'panic';
    }

    const oops = new TestOops('test');
    const panic = new TestPanic('panic');

    expect(oops.isFatal()).toBe(false);
    expect(panic.isFatal()).toBe(true);
  });

  it('should generate combined code', () => {
    class TestOops extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0301' as const;
      readonly oopsCode = 'LM01';
      readonly userMessage = 'test';
    }

    const oops = new TestOops('test');
    expect(oops.getCombinedCode()).toBe('0x0301LM01');
  });

  it('should return internalDetails or message from getInternalDetails()', () => {
    class TestOops extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101' as const;
      readonly oopsCode = 'TS01';
      readonly userMessage = 'user msg';
      override readonly internalDetails = 'debug info';
    }

    const withDetails = new TestOops('msg');
    expect(withDetails.getInternalDetails()).toBe('debug info');

    class TestOopsNoDetails extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101' as const;
      readonly oopsCode = 'TS01';
      readonly userMessage = 'user msg';
    }

    const noDetails = new TestOopsNoDetails('fallback msg');
    expect(noDetails.getInternalDetails()).toBe('fallback msg');
  });

  it('should set name to constructor name', () => {
    class MyCustomError extends OopsError {
      readonly httpStatus = 422;
      readonly errorCode = '0x0101' as const;
      readonly oopsCode = 'TS01';
      readonly userMessage = 'test';
    }

    const err = new MyCustomError('test');
    expect(err.name).toBe('MyCustomError');
  });
});
