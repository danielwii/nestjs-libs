import 'reflect-metadata';

import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { Oops } from '@app/nest/exceptions/oops';

import { describeError, describeErrorParts } from './describe-error';

import { describe, expect, it } from 'bun:test';

const PROBE = 'probe-describe-error-7f3a';

class UpstreamFailure extends Error {}

describe('describeError', () => {
  it('writes the class name and nothing from message or stack', () => {
    const description = describeError(new TypeError(`${PROBE} message`));

    expect(description).toBe('TypeError');
    expect(description).not.toContain(PROBE);
  });

  it('uses the class, not a name property that was assigned afterwards', () => {
    const error = new UpstreamFailure('boom');
    error.name = `${PROBE} name`;

    expect(describeError(error)).toBe('UpstreamFailure');
  });

  it('writes the cause chain as class names without messages', () => {
    const error = new Error(`${PROBE} outer`, {
      cause: new TypeError(`${PROBE} middle`, { cause: new RangeError(`${PROBE} inner`) }),
    });

    expect(describeError(error)).toBe('Error cause=TypeError>RangeError');
  });

  it('reports a non-Error cause as its typeof only', () => {
    expect(describeError(new Error('x', { cause: `${PROBE} text cause` }))).toBe('Error cause=string');
    expect(describeError(new Error('x', { cause: { detail: PROBE } }))).toBe('Error cause=object');
  });

  it('reports the combined code of an Oops and never its userMessage or internalDetails', () => {
    const error = new Oops.Panic({
      errorCode: ErrorCodes.SYSTEM_INTERNAL_ERROR,
      oopsCode: 'SYS01',
      userMessage: `${PROBE} user message`,
      internalDetails: `${PROBE} internal details`,
      cause: new TypeError(`${PROBE} cause`),
    });

    const description = describeError(error);
    expect(description).toBe('Panic code=0x0405SYS01 cause=TypeError');
    expect(description).not.toContain(PROBE);
  });

  it('reports the code field of a non-Oops error when it has the expected shape', () => {
    const error = Object.assign(new Error(`${PROBE} message`), { code: 'ECONNRESET' });

    expect(describeError(error)).toBe('Error code=ECONNRESET');
  });

  it.each([
    ['text with spaces', `${PROBE} with spaces`],
    ['longer than 32 characters', 'A'.repeat(33)],
    ['an empty string', ''],
    ['a number', 14],
    ['an object', { detail: PROBE }],
    ['an array', [PROBE]],
    ['null', null],
  ])('replaces a code that is %s with the fixed value', (_label, code) => {
    const description = describeError(Object.assign(new Error('x'), { code }));

    expect(description).toBe('Error code=other');
    expect(description).not.toContain(PROBE);
  });

  it('accepts the longest and the shortest well-formed code', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'A' }))).toBe('Error code=A');
    expect(describeError(Object.assign(new Error('x'), { code: 'a_B-c.9'.padEnd(32, 'z') }))).toBe(
      `Error code=${'a_B-c.9'.padEnd(32, 'z')}`,
    );
  });

  it('replaces an Oops code that is not well-formed', () => {
    const error = new Oops.Panic({
      errorCode: ErrorCodes.SYSTEM_INTERNAL_ERROR,
      oopsCode: `${PROBE} free text code`,
      userMessage: 'u',
    });

    expect(describeError(error)).toBe('Panic code=other');
  });

  it('survives a cause chain that loops back on itself', () => {
    const first = new Error(`${PROBE} first`);
    const second = new TypeError(`${PROBE} second`, { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(describeError(first)).toBe('Error cause=TypeError');
    expect(describeError(new Error('self', { cause: undefined }))).toBe('Error');

    const selfCause = new Error(`${PROBE} self`);
    (selfCause as { cause?: unknown }).cause = selfCause;
    expect(describeError(selfCause)).toBe('Error');
  });

  it('stops following a very long cause chain', () => {
    let chain: Error = new RangeError('end');
    for (let i = 0; i < 50; i += 1) chain = new TypeError(`layer ${i}`, { cause: chain });

    const layers = describeError(chain).replace('TypeError cause=', '').split('>');
    expect(layers.length).toBe(8);
  });

  it('survives getters that throw', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error(PROBE);
      },
    });
    Object.defineProperty(error, 'cause', {
      get() {
        throw new Error(PROBE);
      },
    });

    expect(describeError(error)).toBe('Error code=other');
  });

  it.each([
    ['a string', `${PROBE} thrown string`, 'string'],
    ['an object', { message: PROBE }, 'object'],
    ['null', null, 'object'],
    ['undefined', undefined, 'undefined'],
    ['a number', 42, 'number'],
  ])('reports %s that is not an Error as its typeof only', (_label, value, expected) => {
    const description = describeError(value);

    expect(description).toBe(expected);
    expect(description).not.toContain(PROBE);
  });

  it('falls back to the generic class name when the class name is not identifier-like', () => {
    const odd = new Error('x');
    Object.defineProperty(odd, 'constructor', { value: { name: `${PROBE} not an identifier` } });

    expect(describeError(odd)).toBe('Error');
  });

  it('exposes the same facts as parts, for renderers that write structured fields', () => {
    const error = Object.assign(new RangeError(`${PROBE} message`, { cause: new TypeError(PROBE) }), {
      code: 'E_LIMIT',
    });

    expect(describeErrorParts(error)).toEqual({ name: 'RangeError', code: 'E_LIMIT', causes: ['TypeError'] });
    expect(describeErrorParts(`${PROBE} thrown`)).toEqual({ name: 'string', causes: [] });
    expect(describeErrorParts(new Error('x'))).toEqual({ name: 'Error', causes: [] });
  });

  it('survives an error whose constructor getter throws, on the error and on a cause', () => {
    const hostile = (message: string, options?: { cause?: unknown }) => {
      const error = new TypeError(message, options);
      Object.defineProperty(error, 'constructor', {
        get() {
          throw new Error(PROBE);
        },
      });
      return error;
    };

    expect(describeError(hostile(`${PROBE} outer`))).toBe('Error');
    expect(describeError(new RangeError('x', { cause: hostile(`${PROBE} cause`) }))).toBe('RangeError cause=Error');
  });

  it('degrades to the typeof of a value whose traps throw', () => {
    const hostile = new Proxy(new Error(`${PROBE} message`), {
      getPrototypeOf() {
        throw new Error(PROBE);
      },
    });

    expect(describeError(hostile)).toBe('object');
    expect(describeErrorParts(hostile)).toEqual({ name: 'object', causes: [] });
  });
});
