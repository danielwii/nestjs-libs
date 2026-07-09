import { prodFormatter, setActiveTraceIdResolver } from '@app/utils/log-formatter';

import { registerActiveTraceIdResolver } from './configure';

import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'bun:test';

import type { LogRecord } from '@app/utils/log-formatter';
import type { Context, ContextManager, Span } from '@opentelemetry/api';

const TRACE_ID = '11111111111111111111111111111111';
const SPAN_ID = '2222222222222222';

class TestContextManager implements ContextManager {
  private activeContext: Context = ROOT_CONTEXT;

  active(): Context {
    return this.activeContext;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    contextValue: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.activeContext;
    this.activeContext = contextValue;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.activeContext = previous;
    }
  }

  bind<T>(_contextValue: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.activeContext = ROOT_CONTEXT;
    return this;
  }
}

const contextManager = new TestContextManager();

context.setGlobalContextManager(contextManager);

afterEach(() => {
  setActiveTraceIdResolver(undefined);
});

function makeRecord(): LogRecord {
  return {
    timestamp: 1_735_689_600_000,
    level: 'info',
    category: ['test'],
    message: ['hello'],
    rawMessage: 'hello',
    properties: {},
  };
}

function makeSpan(traceId: string): Span {
  return {
    spanContext: () => ({
      traceId,
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    }),
  } as unknown as Span;
}

describe('registerActiveTraceIdResolver', () => {
  it('wires LogTape formatter fallback to the active OpenTelemetry span', () => {
    registerActiveTraceIdResolver();

    const ctx = trace.setSpan(context.active(), makeSpan(TRACE_ID));
    context.with(ctx, () => {
      const output = JSON.parse(prodFormatter(makeRecord())) as Record<string, unknown>;

      expect(output.traceId).toBe(TRACE_ID);
    });
  });
});
