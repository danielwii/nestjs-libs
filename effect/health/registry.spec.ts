import { HealthRegistry } from './registry';

import { describe, expect, test } from 'bun:test';
import { Effect, TestContext } from 'effect';

import type { HealthIndicatorResult } from './indicator';

const runTest = <A>(effect: Effect.Effect<A, any, HealthRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(HealthRegistry.Default), Effect.provide(TestContext.TestContext)));

const fakeIndicator = (name: string, type: 'readiness' | 'topology', healthy = true) =>
  ({
    type,
    check: () => Effect.succeed({ name, healthy } satisfies HealthIndicatorResult),
  }) as const;

// ==================== register + getByType ====================

describe('register + getByType', () => {
  test('register readiness indicator and retrieve by type', () =>
    runTest(
      Effect.gen(function* () {
        yield* HealthRegistry.register(fakeIndicator('db', 'readiness'));
        const indicators = yield* HealthRegistry.getByType('readiness');
        expect(indicators).toHaveLength(1);
        expect(indicators[0]!.type).toBe('readiness');
      }),
    ));

  test('register multiple types and filter', () =>
    runTest(
      Effect.gen(function* () {
        yield* HealthRegistry.register(fakeIndicator('db', 'readiness'));
        yield* HealthRegistry.register(fakeIndicator('downstream', 'topology'));
        yield* HealthRegistry.register(fakeIndicator('redis', 'readiness'));

        const readiness = yield* HealthRegistry.getByType('readiness');
        expect(readiness).toHaveLength(2);

        const topology = yield* HealthRegistry.getByType('topology');
        expect(topology).toHaveLength(1);
      }),
    ));
});

// ==================== checkAll ====================

describe('checkAll', () => {
  test('runs all checks of given type', () =>
    runTest(
      Effect.gen(function* () {
        yield* HealthRegistry.register(fakeIndicator('db', 'readiness'));
        yield* HealthRegistry.register(fakeIndicator('redis', 'readiness', true));
        const results = yield* HealthRegistry.checkAll('readiness');
        expect(results).toHaveLength(2);
        expect(results[0]!.healthy).toBe(true);
        expect(results[1]!.healthy).toBe(true);
      }),
    ));

  test('returns empty array when no indicators', () =>
    runTest(
      Effect.gen(function* () {
        const results = yield* HealthRegistry.checkAll('readiness');
        expect(results).toEqual([]);
      }),
    ));
});

// ==================== markShuttingDown / isShuttingDown ====================

describe('shutdown state', () => {
  test('initially not shutting down', () =>
    runTest(
      Effect.gen(function* () {
        const shutting = yield* HealthRegistry.isShuttingDown();
        expect(shutting).toBe(false);
      }),
    ));

  test('true after markShuttingDown', () =>
    runTest(
      Effect.gen(function* () {
        yield* HealthRegistry.markShuttingDown();
        const shutting = yield* HealthRegistry.isShuttingDown();
        expect(shutting).toBe(true);
      }),
    ));
});

// ==================== defect handling ====================

describe('defect in check', () => {
  test('defect is caught and returns unhealthy', () =>
    runTest(
      Effect.gen(function* () {
        yield* HealthRegistry.register({
          type: 'readiness',
          check: () => Effect.die(new Error('unexpected crash')),
        });
        const results = yield* HealthRegistry.checkAll('readiness');
        expect(results).toHaveLength(1);
        expect(results[0]!.healthy).toBe(false);
        expect(results[0]!.error).toContain('unexpected crash');
      }),
    ));
});
