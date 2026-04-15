import { Oops } from './oops';
import { coerceOopsError, isOopsError, OopsError } from './oops-error';

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

  it('isOopsError should detect any OopsError subclass', () => {
    const panic = new Oops.Panic({
      errorCode: '0x0305',
      userMessage: 'panic',
      internalDetails: 'panic details',
    });

    expect(isOopsError(panic)).toBe(true);
    expect(isOopsError(new Error('boom'))).toBe(false);
    expect(isOopsError('boom')).toBe(false);
  });

  it('coerceOopsError should preserve existing OopsError instances', () => {
    const existing = new Oops.Panic({
      errorCode: '0x0305',
      userMessage: 'panic',
      internalDetails: 'panic details',
    });

    const fallback = () =>
      new Oops.Panic({
        errorCode: '0x0305',
        userMessage: 'fallback',
        internalDetails: 'fallback details',
      });

    expect(coerceOopsError(existing, fallback)).toBe(existing);
  });

  it('coerceOopsError should wrap unknown errors with fallback', () => {
    const fallback = (error: unknown) =>
      new Oops.Panic({
        errorCode: '0x0305',
        userMessage: 'fallback',
        internalDetails: error instanceof Error ? error.message : String(error),
      });

    const wrapped = coerceOopsError(new Error('boom'), fallback);
    expect(wrapped).toBeInstanceOf(OopsError);
    expect(wrapped).toBeInstanceOf(Oops.Panic);
    expect(wrapped.getInternalDetails()).toBe('boom');
  });
});
