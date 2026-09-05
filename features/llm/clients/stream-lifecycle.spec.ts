import { createStreamLifecycle } from './stream-lifecycle';

import { describe, expect, it } from 'bun:test';

interface ErrorEvent {
  error: unknown;
}

interface EndEvent {
  usage: { totalTokens: number };
  finalStep?: { usage: { totalTokens: number } };
}

interface AbortEvent {
  reason?: unknown;
}

function createHarness<ERROR_RESULT = void>(
  callbacks: Parameters<typeof createStreamLifecycle<ErrorEvent, EndEvent, AbortEvent, ERROR_RESULT>>[0] = {},
) {
  const trace: string[] = [];
  const loggedErrorResults: (ERROR_RESULT | undefined)[] = [];
  const lifecycle = createStreamLifecycle(callbacks, {
    cleanup: () => trace.push('cleanup'),
    logErrorEvent: (_event, result) => {
      loggedErrorResults.push(result);
      trace.push('error-event');
    },
    logSuccess: (event) => trace.push(`success:${event.usage.totalTokens}`),
    logAbort: () => trace.push('abort'),
    logFailure: () => trace.push('failure'),
  });

  return { lifecycle, trace, loggedErrorResults };
}

describe('createStreamLifecycle', () => {
  it('finalizes success once with aggregate usage rather than final-step usage', async () => {
    const { lifecycle, trace } = createHarness({
      onEnd: () => {
        trace.push('caller-end');
      },
    });

    await lifecycle.onEnd({
      usage: { totalTokens: 8 },
      finalStep: { usage: { totalTokens: 5 } },
    });
    await lifecycle.onEnd({ usage: { totalTokens: 13 } });

    expect(lifecycle.getState()).toBe('success');
    expect(trace).toEqual(['caller-end', 'cleanup', 'success:8']);
  });

  it('cleans up and logs success when the caller onEnd throws', async () => {
    const expected = new Error('caller end failed');
    const { lifecycle, trace } = createHarness({
      onEnd: () => {
        trace.push('caller-end');
        throw expected;
      },
    });

    expect(lifecycle.onEnd({ usage: { totalTokens: 5 } })).rejects.toBe(expected);
    await Promise.resolve();

    expect(lifecycle.getState()).toBe('success');
    expect(trace).toEqual(['caller-end', 'cleanup', 'success:5']);
  });

  it('keeps error events non-terminal and allows later success', async () => {
    const { lifecycle, trace } = createHarness({
      onError: () => {
        trace.push('caller-error');
      },
      onEnd: () => {
        trace.push('caller-end');
      },
    });

    await lifecycle.onError({ error: new Error('recoverable') });
    expect(lifecycle.getState()).toBe('pending');
    expect(trace).toEqual(['caller-error', 'error-event']);

    await lifecycle.onEnd({ usage: { totalTokens: 3 } });
    expect(trace).toEqual(['caller-error', 'error-event', 'caller-end', 'cleanup', 'success:3']);
  });

  it('forwards the caller onError result to both the SDK and the error-event log', async () => {
    const { lifecycle, trace, loggedErrorResults } = createHarness<void | { retry: true }>({
      onError: () => {
        trace.push('caller-error');
        return { retry: true };
      },
    });

    const result = await lifecycle.onError({ error: new Error('provider') });

    expect(result).toEqual({ retry: true });
    expect(loggedErrorResults).toEqual([{ retry: true }]);
    expect(lifecycle.getState()).toBe('pending');
    expect(trace).toEqual(['caller-error', 'error-event']);
  });

  it('logs the error event with an undefined result when the caller onError throws', async () => {
    const { lifecycle, loggedErrorResults } = createHarness<void | { retry: true }>({
      onError: () => {
        throw new Error('caller error callback failed');
      },
    });

    expect(lifecycle.onError({ error: new Error('provider') })).rejects.toThrow('caller error callback failed');
    await Promise.resolve();

    expect(loggedErrorResults).toEqual([undefined]);
  });

  it('logs an error event even when the caller callback throws', async () => {
    const expected = new Error('caller error callback failed');
    const { lifecycle, trace } = createHarness({
      onError: () => {
        trace.push('caller-error');
        throw expected;
      },
    });

    expect(lifecycle.onError({ error: new Error('provider event') })).rejects.toBe(expected);
    await Promise.resolve();

    expect(lifecycle.getState()).toBe('pending');
    expect(trace).toEqual(['caller-error', 'error-event']);
  });

  it('finalizes abort exactly once when the caller callback throws', async () => {
    const expected = new Error('caller abort failed');
    const { lifecycle, trace } = createHarness({
      onAbort: () => {
        trace.push('caller-abort');
        throw expected;
      },
    });

    expect(lifecycle.onAbort({ reason: 'cancelled' })).rejects.toBe(expected);
    await Promise.resolve();
    await lifecycle.onAbort({ reason: 'duplicate' });

    expect(lifecycle.getState()).toBe('abort');
    expect(trace).toEqual(['caller-abort', 'cleanup', 'abort']);
  });

  it('finalizes fatal failure exactly once', () => {
    const { lifecycle, trace } = createHarness();

    expect(lifecycle.fail(new Error('fatal'))).toBe(true);
    expect(lifecycle.fail(new Error('duplicate'))).toBe(false);

    expect(lifecycle.getState()).toBe('failure');
    expect(trace).toEqual(['cleanup', 'failure']);
  });

  it('lets the first terminal claim win', async () => {
    const { lifecycle, trace } = createHarness({
      onEnd: () => {
        trace.push('caller-end');
      },
      onAbort: () => {
        trace.push('caller-abort');
      },
    });

    const end = lifecycle.onEnd({ usage: { totalTokens: 1 } });
    const abort = lifecycle.onAbort({ reason: 'too late' });
    lifecycle.fail(new Error('too late'));
    await Promise.all([end, abort]);

    expect(lifecycle.getState()).toBe('success');
    expect(trace).toEqual(['caller-end', 'cleanup', 'success:1']);
  });
});
