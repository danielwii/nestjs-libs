import { createDbHealthIndicator, createRedisHealthIndicator } from './indicator';

import { describe, expect, test } from 'bun:test';
import { Effect, Fiber, TestClock, TestContext } from 'effect';

const runTest = <A>(effect: Effect.Effect<A, any, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

// ==================== DB Health Indicator ====================

describe('createDbHealthIndicator', () => {
  test('successful query returns healthy with latency', async () => {
    const indicator = createDbHealthIndicator(() => Promise.resolve(1));
    const result = await Effect.runPromise(indicator.check());
    expect(result.name).toBe('database');
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  test('failed query returns unhealthy with error', async () => {
    const indicator = createDbHealthIndicator(() => Promise.reject(new Error('connection refused')));
    const result = await Effect.runPromise(indicator.check());
    expect(result.name).toBe('database');
    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('times out slow query', () =>
    runTest(
      Effect.gen(function* () {
        const indicator = createDbHealthIndicator(() => new Promise(() => {}));
        const fiber = yield* indicator.check().pipe(Effect.fork);
        yield* TestClock.adjust('3 seconds');
        const result = yield* Fiber.join(fiber);
        expect(result.healthy).toBe(false);
        expect(result.error).toBeDefined();
      }),
    ));
});

// ==================== Redis Health Indicator ====================

describe('createRedisHealthIndicator', () => {
  test('PONG returns healthy', async () => {
    const indicator = createRedisHealthIndicator(() => Promise.resolve('PONG'));
    const result = await Effect.runPromise(indicator.check());
    expect(result.name).toBe('redis');
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('non-PONG returns unhealthy', async () => {
    const indicator = createRedisHealthIndicator(() => Promise.resolve('NOT_PONG'));
    const result = await Effect.runPromise(indicator.check());
    expect(result.name).toBe('redis');
    expect(result.healthy).toBe(false);
  });

  test('rejected promise returns unhealthy with error', async () => {
    const indicator = createRedisHealthIndicator(() => Promise.reject(new Error('redis down')));
    const result = await Effect.runPromise(indicator.check());
    expect(result.name).toBe('redis');
    expect(result.healthy).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('times out slow ping', () =>
    runTest(
      Effect.gen(function* () {
        const indicator = createRedisHealthIndicator(() => new Promise(() => {}));
        const fiber = yield* indicator.check().pipe(Effect.fork);
        yield* TestClock.adjust('3 seconds');
        const result = yield* Fiber.join(fiber);
        expect(result.healthy).toBe(false);
        expect(result.error).toBeDefined();
      }),
    ));
});
