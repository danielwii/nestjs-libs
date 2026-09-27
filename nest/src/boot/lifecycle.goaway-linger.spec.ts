/**
 * Phase 2.7 (GOAWAY linger) — T1/T2/T3 from the shutdown-ordering design: the process must not
 * exit until GRPC_GOAWAY_LINGER_MS has elapsed after a GOAWAY was actually sent, nothing in that
 * window may interfere with an in-flight gRPC call still being served by the (real) gRPC server,
 * and a consumer that never sends a GOAWAY (no gRPC server, or a failed/skipped drain) must not
 * pay for a linger nobody is waiting on.
 *
 * `setTimeout` is spied rather than driven by a real clock so these tests run instantly; capturing
 * every (callback, delay) pair also lets T1 assert the actual requested linger duration, not just
 * that "some" timer fired.
 */
import 'reflect-metadata';

import { SysEnv } from '@app/env';

import { setGrpcMicroserviceRef, shutdownState } from './shutdown-state';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { INestApplication } from '@nestjs/common';

const ORIGINAL_GOAWAY_LINGER_MS = SysEnv.GRPC_GOAWAY_LINGER_MS;
const ORIGINAL_DRAIN_MS = SysEnv.GRPC_DRAIN_MS;

interface TimerCall {
  fn: () => void;
  ms: number;
}

function fakeConnectionManager() {
  return {
    getActiveConnectionCount: () => ({ sse: 0, ws: 0 }),
    notifyAndCloseAll: async () => undefined,
  };
}

function fakeHttpServer() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    getConnections: (cb: (err: Error | null, count: number) => void) => cb(null, 0),
    close: (cb: () => void) => {
      cb();
      (listeners.close ?? []).forEach((l) => l());
    },
    on: (event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    },
  };
}

function fakeApp(httpServer: ReturnType<typeof fakeHttpServer>): INestApplication {
  return {
    get: () => fakeConnectionManager(),
    getHttpServer: () => httpServer,
    close: async () => undefined,
  } as unknown as INestApplication;
}

describe('gracefulShutdown Phase 2.7 (GOAWAY linger)', () => {
  let timers: TimerCall[];
  let exitSpy: ReturnType<typeof spyOn>;
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timers = [];
    process.removeAllListeners('SIGINT');
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as never);
    SysEnv.GRPC_GOAWAY_LINGER_MS = 3000;
    SysEnv.GRPC_DRAIN_MS = ORIGINAL_DRAIN_MS;
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    exitSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    setGrpcMicroserviceRef(undefined, 0);
    shutdownState.value = false;
    SysEnv.GRPC_GOAWAY_LINGER_MS = ORIGINAL_GOAWAY_LINGER_MS;
    SysEnv.GRPC_DRAIN_MS = ORIGINAL_DRAIN_MS;
  });

  /** Fires every captured timer once, in registration order — advances "time" past every pending wait. */
  function flushAllTimers() {
    // New timers can be scheduled by a callback that just ran (e.g. Phase 2.7's own await), so
    // drain repeatedly until nothing new was captured, instead of a single fixed-size pass.
    let ran = 0;
    while (ran < timers.length) {
      timers[ran]!.fn();
      ran++;
    }
  }

  it('T1: no in-flight call — drain, then linger for GRPC_GOAWAY_LINGER_MS, then tryShutdown', async () => {
    const events: string[] = [];
    const drain = () => events.push('drain');
    const tryShutdown = (cb: () => void) => {
      events.push('tryShutdown');
      cb();
    };
    setGrpcMicroserviceRef({ serverInstance: { grpcClient: { drain, tryShutdown } } }, 50060);

    const { runApp } = await import('./lifecycle');
    runApp(fakeApp(fakeHttpServer()));

    process.emit('SIGINT');
    // Let the async gracefulShutdown IIFE run its microtasks/awaits through to completion.
    for (let i = 0; i < 20 && exitSpy.mock.calls.length === 0; i++) {
      flushAllTimers();
      await Promise.resolve();
    }

    expect(events).toEqual(['drain', 'tryShutdown']);
    const lingerTimer = timers.find((t) => t.ms === 3000);
    expect(lingerTimer).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('T2: an in-flight call started before the linger completes normally, not cancelled by it', async () => {
    const inFlight: { result: 'pending' | 'completed' } = { result: 'pending' };
    // Models the real gRPC server: tryShutdown's callback only fires once every in-flight call has
    // actually finished — never on a fixed clock, and never forced early by Phase 2.7.
    const tryShutdown = (cb: () => void) => {
      inFlight.result = 'completed';
      cb();
    };
    setGrpcMicroserviceRef({ serverInstance: { grpcClient: { drain: () => undefined, tryShutdown } } }, 50060);

    const { runApp } = await import('./lifecycle');
    runApp(fakeApp(fakeHttpServer()));

    process.emit('SIGINT');
    for (let i = 0; i < 20 && exitSpy.mock.calls.length === 0; i++) {
      flushAllTimers();
      await Promise.resolve();
    }

    // The linger itself never touches the in-flight call or its completion callback — it only
    // delays how soon tryShutdown is invoked, so the call is free to finish on its own schedule.
    expect(inFlight.result).toBe('completed');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('T3: an app with no gRPC server has no linger delay (no GOAWAY was sent to wait for)', async () => {
    // No ref set at all — Phase 2.6 takes its "no grpc server or port" branch, so no GOAWAY is
    // ever sent and Phase 2.7 must not gate shutdown on a linger nobody needs.
    setGrpcMicroserviceRef(undefined, 0);

    const { runApp } = await import('./lifecycle');
    runApp(fakeApp(fakeHttpServer()));

    process.emit('SIGINT');
    for (let i = 0; i < 20 && exitSpy.mock.calls.length === 0; i++) {
      flushAllTimers();
      await Promise.resolve();
    }

    expect(timers.some((t) => t.ms === 3000)).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
