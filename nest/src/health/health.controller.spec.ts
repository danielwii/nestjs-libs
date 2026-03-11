import { HealthRegistry } from './health-registry';
import { HealthController } from './health.controller';

import { describe, expect, test } from 'bun:test';

import type { HealthIndicator } from './health-indicator';

// ==================== Test Helpers ====================

function mockIndicator(name: string, healthy: boolean, latencyMs = 5): HealthIndicator {
  return {
    type: 'topology',
    check: async () => ({
      name,
      healthy,
      latencyMs,
      ...(healthy ? {} : { error: 'Deadline exceeded' }),
    }),
  };
}

function setup(...indicators: HealthIndicator[]) {
  const registry = new HealthRegistry();
  for (const i of indicators) registry.register(i);
  return new HealthController(registry);
}

/** Mock Express Response that captures status + json */
function mockRes() {
  let capturedStatus = 200;
  let capturedBody: unknown;
  const res = {
    status(code: number) {
      capturedStatus = code;
      return res;
    },
    json(body: unknown) {
      capturedBody = body;
      return res;
    },
  };
  return {
    res: res as unknown as import('express').Response,
    get statusCode() {
      return capturedStatus;
    },
    get body() {
      return capturedBody as Record<string, unknown>;
    },
  };
}

// ==================== Tests ====================

describe('HealthController /health/topology', () => {
  test('无 indicator → 200 ok', async () => {
    const controller = setup();
    const mock = mockRes();
    await controller.topology(mock.res);
    expect(mock.statusCode).toBe(200);
    expect(mock.body.status).toBe('ok');
    expect(mock.body.checks).toEqual({});
  });

  test('全部健康 → 200 ok', async () => {
    const controller = setup(
      mockIndicator('grpc:ai-persona', true),
      mockIndicator('grpc:marsgate', true),
      mockIndicator('grpc:thirdparty', true),
    );
    const mock = mockRes();
    await controller.topology(mock.res);
    expect(mock.statusCode).toBe(200);
    expect(mock.body.status).toBe('ok');
    const checks = mock.body.checks as Record<string, { healthy: boolean }>;
    expect(checks['grpc:ai-persona']?.healthy).toBe(true);
    expect(checks['grpc:marsgate']?.healthy).toBe(true);
    expect(checks['grpc:thirdparty']?.healthy).toBe(true);
  });

  test('部分不通 → 503 degraded（黄）', async () => {
    const controller = setup(
      mockIndicator('grpc:ai-persona', true),
      mockIndicator('grpc:marsgate', false),
      mockIndicator('grpc:thirdparty', true),
    );
    const mock = mockRes();
    await controller.topology(mock.res);
    expect(mock.statusCode).toBe(503);
    expect(mock.body.status).toBe('degraded');
    const checks = mock.body.checks as Record<string, { healthy: boolean }>;
    expect(checks['grpc:marsgate']?.healthy).toBe(false);
    expect(checks['grpc:ai-persona']?.healthy).toBe(true);
  });

  test('全部不通 → 503 down（红）', async () => {
    const controller = setup(
      mockIndicator('grpc:ai-persona', false),
      mockIndicator('grpc:marsgate', false),
      mockIndicator('grpc:thirdparty', false),
    );
    const mock = mockRes();
    await controller.topology(mock.res);
    expect(mock.statusCode).toBe(503);
    expect(mock.body.status).toBe('down');
    const checks = mock.body.checks as Record<string, { healthy: boolean }>;
    expect(checks['grpc:ai-persona']?.healthy).toBe(false);
  });
});
