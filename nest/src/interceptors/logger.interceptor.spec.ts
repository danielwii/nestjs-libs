import { SysEnv } from '@app/env';

import { Oops } from '../exceptions/oops';
import { isExpectedOopsError, LoggerInterceptor } from './logger.interceptor';

import { configure, reset } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lastValueFrom, of, throwError } from 'rxjs';

import type { LogRecord } from '@logtape/logtape';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

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

const PROBE = 'probe-payload-4c1e';

class FixtureController {
  handle(): void {}
}

function rpcContext(data: unknown): ExecutionContext {
  return {
    getType: () => 'rpc',
    getClass: () => FixtureController,
    getHandler: () => FixtureController.prototype.handle,
    switchToHttp: () => ({ getRequest: () => undefined }),
    switchToRpc: () => ({ getData: () => data, getContext: () => ({ get: () => [] }) }),
  } as unknown as ExecutionContext;
}

function httpContext(body: unknown): ExecutionContext {
  const req = {
    url: '/fixture',
    path: '/fixture',
    method: 'POST',
    body,
    query: {},
    params: {},
    headers: {},
    ips: [],
    hostname: 'localhost',
  };
  return {
    getType: () => 'http',
    getClass: () => FixtureController,
    getHandler: () => FixtureController.prototype.handle,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const handler: CallHandler = { handle: () => of('done') };

describe('LoggerInterceptor request-entry payload log', () => {
  let records: LogRecord[] = [];

  beforeEach(async () => {
    records = [];
    await configure({
      reset: true,
      sinks: { memory: (record) => void (record.category[0] !== 'logtape' && records.push(record)) },
      loggers: [{ category: [], sinks: ['memory'], lowestLevel: 'debug' }],
    });
  });

  const originalLogRequestPayloads = SysEnv.LOG_REQUEST_PAYLOADS;

  afterEach(async () => {
    SysEnv.LOG_REQUEST_PAYLOADS = originalLogRequestPayloads;
    await reset();
  });

  const logged = () => JSON.stringify(records.map((record) => [record.message, record.properties]));

  async function run(context: ExecutionContext, interceptor = new LoggerInterceptor()) {
    await lastValueFrom(await interceptor.intercept(context, handler));
  }

  const rpcPayload = {
    subject: `${PROBE} short subject`,
    body_text: `${PROBE} short body`,
    history: [{ role: 'assistant', content: `${PROBE} derived answer` }],
    [`${PROBE}-key-name`]: 'x',
  };

  it('writes only the method, timing, key count and length for an RPC payload by default', async () => {
    await run(rpcContext(rpcPayload));

    expect(logged()).not.toContain(PROBE);
    expect(logged()).toContain('FixtureController.handle');
    expect(logged()).toContain('spent');
    expect(logged()).toContain('"topLevelKeys":4');
    expect(logged()).toContain(`"payloadLength":${JSON.stringify(rpcPayload).length}`);
  });

  it('writes only the key count and length for an HTTP body by default, including the failure log', async () => {
    const failing: CallHandler = { handle: () => throwError(() => new Error('fixture failure')) };

    await expect(
      lastValueFrom(await new LoggerInterceptor().intercept(httpContext(rpcPayload), failing)),
    ).rejects.toThrow('fixture failure');

    expect(logged()).not.toContain(PROBE);
    expect(logged()).toContain('"topLevelKeys":4');
    expect(logged()).toContain(`"payloadLength":${JSON.stringify(rpcPayload).length}`);
  });

  it('summarizes arrays, scalars, binary and unserializable payloads without throwing', async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    await run(rpcContext([1, 2, 3]));
    await run(rpcContext(null));
    await run(rpcContext(new Uint8Array(7)));
    await run(rpcContext(circular));
    await run(rpcContext({ big: 10n }));

    const entries = records
      .map((record) => record.message.map(String).join(''))
      .filter((line) => line.includes('data='));
    expect(entries).toHaveLength(5);
    const summaries = JSON.stringify(records.map((record) => record.message));
    expect(summaries).toContain('"topLevelKeys":3');
    expect(summaries).toContain('"payloadLength":7');
    expect(summaries).toContain('"payloadLength":null');
  });

  it('writes normalized values when the application opts in with the option', async () => {
    await run(
      rpcContext({ ...rpcPayload, apiKey: 'sk-live-secret' }),
      new LoggerInterceptor({ logPayloadValues: true }),
    );

    expect(logged()).toContain(`${PROBE} short subject`);
    expect(logged()).toContain(`${PROBE}-key-name`);
    expect(logged()).not.toContain('sk-live-secret');
    expect(logged()).not.toContain('topLevelKeys');
  });

  it('writes normalized values when SysEnv.LOG_REQUEST_PAYLOADS is on, and the option wins over it', async () => {
    SysEnv.LOG_REQUEST_PAYLOADS = true;
    await run(rpcContext(rpcPayload));
    expect(logged()).toContain(`${PROBE} short subject`);

    records = [];
    await run(rpcContext(rpcPayload), new LoggerInterceptor({ logPayloadValues: false }));
    expect(logged()).not.toContain(PROBE);
  });

  it('keeps payload values out when neither the option nor the setting is on', async () => {
    expect(SysEnv.LOG_REQUEST_PAYLOADS).toBe(false);
    await run(rpcContext(rpcPayload));
    expect(logged()).not.toContain(PROBE);

    SysEnv.LOG_REQUEST_PAYLOADS = false;
    records = [];
    await run(rpcContext(rpcPayload), new LoggerInterceptor({}));
    expect(logged()).not.toContain(PROBE);
  });
});
