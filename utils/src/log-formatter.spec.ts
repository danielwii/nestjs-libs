import { devFormatter, prodFormatter } from './log-formatter';

import { context, trace, TraceFlags } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { LogRecord } from './log-formatter';

const TRACE_ID = '11111111111111111111111111111111';
const OTHER_TRACE_ID = '22222222222222222222222222222222';
const EXPLICIT_TRACE_ID = '33333333333333333333333333333333';
const INVALID_TRACE_ID = '00000000000000000000000000000000';
const SPAN_ID = '4444444444444444';

let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider();
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
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

function withActiveTrace<T>(traceId: string, callback: () => T): T {
  const span = trace.wrapSpanContext({
    traceId,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  });

  return context.with(trace.setSpan(context.active(), span), callback);
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('devFormatter trace context', () => {
  it('does not add a trace tag without record or active span traceId', () => {
    const output = stripAnsi(devFormatter(makeRecord()));

    expect(output).not.toContain('[');
  });

  it('uses record traceId before active span traceId', () => {
    const output = withActiveTrace(OTHER_TRACE_ID, () =>
      stripAnsi(devFormatter(makeRecord({ traceId: EXPLICIT_TRACE_ID }))),
    );

    expect(output).toContain(`[${EXPLICIT_TRACE_ID}]`);
    expect(output).not.toContain(OTHER_TRACE_ID);
  });

  it('falls back to active span traceId', () => {
    const output = withActiveTrace(TRACE_ID, () => stripAnsi(devFormatter(makeRecord())));

    expect(output).toContain(`[${TRACE_ID}]`);
  });

  it('does not inject an invalid active span traceId', () => {
    const output = withActiveTrace(INVALID_TRACE_ID, () => stripAnsi(devFormatter(makeRecord())));

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
    const output = withActiveTrace(
      OTHER_TRACE_ID,
      () => JSON.parse(prodFormatter(makeRecord({ traceId: EXPLICIT_TRACE_ID }))) as Record<string, unknown>,
    );

    expect(output.traceId).toBe(EXPLICIT_TRACE_ID);
  });

  it('falls back to active span traceId', () => {
    const output = withActiveTrace(TRACE_ID, () => JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>);

    expect(output.traceId).toBe(TRACE_ID);
  });

  it('does not inject an invalid active span traceId', () => {
    const output = withActiveTrace(
      INVALID_TRACE_ID,
      () => JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>,
    );

    expect(output.traceId).toBeUndefined();
  });
});
