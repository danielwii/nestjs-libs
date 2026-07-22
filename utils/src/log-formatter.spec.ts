import { devFormatter, prodFormatter, setActiveTraceIdResolver } from './log-formatter';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as process from 'node:process';

import { afterEach, describe, expect, it } from 'bun:test';
import JSON5 from 'json5';

import type { LogRecord } from './log-formatter';

const TRACE_ID = '11111111111111111111111111111111';
const OTHER_TRACE_ID = '22222222222222222222222222222222';
const EXPLICIT_TRACE_ID = '33333333333333333333333333333333';
const INVALID_TRACE_ID = '00000000000000000000000000000000';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_NO_COLOR = process.env.NO_COLOR;

afterEach(() => {
  setActiveTraceIdResolver(undefined);
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.NO_COLOR = ORIGINAL_NO_COLOR;
});

function makeRecord(properties: Record<string, unknown> = {}): LogRecord {
  return {
    timestamp: 1_735_689_600_000,
    level: 'info',
    category: ['test'],
    message: ['hello'],
    rawMessage: 'hello',
    properties,
  };
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('devFormatter trace context', () => {
  it('does not import optional OpenTelemetry from the shared formatter', () => {
    const source = readFileSync(join(import.meta.dir, 'log-formatter.ts'), 'utf8');

    expect(source).not.toContain('@opentelemetry/api');
  });

  it('does not add a trace tag without record or active span traceId', () => {
    const output = stripAnsi(devFormatter(makeRecord()));

    expect(output).not.toContain('[');
  });

  it('uses record traceId before active span traceId', () => {
    setActiveTraceIdResolver(() => OTHER_TRACE_ID);
    const output = stripAnsi(devFormatter(makeRecord({ traceId: EXPLICIT_TRACE_ID })));

    expect(output).toContain(`[${EXPLICIT_TRACE_ID}]`);
    expect(output).not.toContain(OTHER_TRACE_ID);
  });

  it('falls back to the injected active traceId resolver', () => {
    setActiveTraceIdResolver(() => TRACE_ID);
    const output = stripAnsi(devFormatter(makeRecord()));

    expect(output).toContain(`[${TRACE_ID}]`);
  });

  it('does not inject an invalid active traceId', () => {
    setActiveTraceIdResolver(() => INVALID_TRACE_ID);
    const output = stripAnsi(devFormatter(makeRecord()));

    expect(output).not.toContain(INVALID_TRACE_ID);
    expect(output).not.toContain('[');
  });
});

describe('prodFormatter trace context', () => {
  it('does not add traceId without record or active span traceId', () => {
    const output = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;

    expect(output.traceId).toBeUndefined();
  });

  it('uses record traceId before active span traceId', () => {
    setActiveTraceIdResolver(() => OTHER_TRACE_ID);
    const output = JSON.parse(prodFormatter(makeRecord({ traceId: EXPLICIT_TRACE_ID }))) as Record<string, unknown>;

    expect(output.traceId).toBe(EXPLICIT_TRACE_ID);
  });

  it('falls back to the injected active traceId resolver', () => {
    setActiveTraceIdResolver(() => TRACE_ID);
    const output = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;

    expect(output.traceId).toBe(TRACE_ID);
  });

  it('does not inject an invalid active traceId', () => {
    setActiveTraceIdResolver(() => INVALID_TRACE_ID);
    const output = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;

    expect(output.traceId).toBeUndefined();
  });
});

describe('prodFormatter message rendering', () => {
  it('renders tagged-template object interpolations with the shared value formatter', () => {
    process.env.NODE_ENV = 'production';
    const output = JSON.parse(
      prodFormatter({
        ...makeRecord(),
        message: ['config=', { key: 'I18N_EXCEPTION_ENABLED', value: true }, ''],
        rawMessage: ['config=', ''] as unknown as TemplateStringsArray,
      }),
    ) as Record<string, unknown>;

    expect(output.message).not.toContain('[object Object]');
    const renderedConfig = JSON5.parse((output.message as string).slice('config='.length)) as Record<string, unknown>;
    expect(renderedConfig).toEqual({
      key: 'I18N_EXCEPTION_ENABLED',
      value: true,
    });
  });

  it('preserves structured Error details in production', () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('provider unavailable');
    error.stack = 'Error: provider unavailable\n    at transcribe (voice.ts:1:1)';
    const output = JSON.parse(
      prodFormatter({
        ...makeRecord(),
        level: 'error',
        message: ['failed: ', error, ''],
        rawMessage: ['failed: ', ''] as unknown as TemplateStringsArray,
      }),
    ) as Record<string, unknown>;

    const renderedError = JSON5.parse((output.message as string).slice('failed: '.length)) as Record<string, unknown>;
    expect(renderedError.name).toBe('Error');
    expect(renderedError.message).toBe('provider unavailable');
    expect(renderedError.stack).toContain('transcribe');
  });

  it('renders circular objects without throwing or emitting ANSI in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NO_COLOR;
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;

    const output = JSON.parse(
      prodFormatter({
        ...makeRecord(),
        message: ['payload=', circular, ''],
        rawMessage: ['payload=', ''] as unknown as TemplateStringsArray,
      }),
    ) as Record<string, unknown>;

    expect(output.message).not.toContain('[object Object]');
    expect(output.message).not.toContain('\x1b[');
    expect(output.message).toContain('Circular');
  });
});
