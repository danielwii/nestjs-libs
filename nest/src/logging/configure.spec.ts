import { prodFormatter, setActiveTraceIdResolver } from '@app/utils/log-formatter';

import { configureLogging, registerActiveTraceIdResolver } from './configure';

import { getLogger, reset } from '@logtape/logtape';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';

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

describe('configureLogging level', () => {
  // The preload (instrument.ts) calls configureLogging() before the app loads; bootstrap calls it again with SysEnv.LOG_LEVEL.
  // Before, the first call pinned LogTape to debug and LOG_LEVEL never took effect.
  const debugLines = async (run: () => Promise<void>): Promise<string[]> => {
    const seen: string[] = [];
    const spy = spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
    });
    try {
      await run();
      getLogger(['configure-spec']).debug('probe-debug-line');
    } finally {
      spy.mockRestore();
    }
    return seen.filter((line) => line.includes('probe-debug-line'));
  };
  const envBefore = process.env.LOG_LEVEL;

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = envBefore;
    await reset();
  });

  it('the preload call reads LOG_LEVEL from the environment', async () => {
    process.env.LOG_LEVEL = 'log';
    expect(await debugLines(() => configureLogging())).toEqual([]);
  });

  it('a later call with another level reconfigures instead of being ignored', async () => {
    process.env.LOG_LEVEL = 'log';
    expect(await debugLines(() => configureLogging('debug'))).toHaveLength(1);
    expect(await debugLines(() => configureLogging('log'))).toEqual([]);
  });

  it('without LOG_LEVEL the default stays debug', async () => {
    delete process.env.LOG_LEVEL;
    expect(await debugLines(() => configureLogging())).toHaveLength(1);
  });

  it('an unknown LOG_LEVEL falls back to debug rather than throwing in the preload', async () => {
    process.env.LOG_LEVEL = 'chatty';
    expect(await debugLines(() => configureLogging())).toHaveLength(1);
  });
});
