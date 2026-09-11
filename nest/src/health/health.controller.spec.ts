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

function readinessIndicator(name: string, healthy: boolean, critical?: boolean): HealthIndicator {
  return {
    type: 'readiness',
    ...(critical === undefined ? {} : { critical }),
    check: async () => ({ name, healthy, latencyMs: 3, ...(healthy ? {} : { error: 'ECONNRESET' }) }),
  };
}

// ==================== Tests ====================

describe('HealthController /health/ready — critical vs soft dependencies', () => {
  test('全部健康 → 200 ready', async () => {
    const controller = setup(readinessIndicator('database', true), readinessIndicator('redis', true, false));
    const mock = mockRes();
    await controller.ready(mock.res);
    expect(mock.statusCode).toBe(200);
    expect(mock.body.status).toBe('ready');
  });

  test('critical（database）失败 → 503 not_ready', async () => {
    const controller = setup(readinessIndicator('database', false), readinessIndicator('redis', true, false));
    const mock = mockRes();
    await controller.ready(mock.res);
    expect(mock.statusCode).toBe(503);
    expect(mock.body.status).toBe('not_ready');
  });

  test('未声明 critical 的 indicator 失败 → 仍按硬依赖 503（向后兼容）', async () => {
    const controller = setup(readinessIndicator('legacy', false));
    const mock = mockRes();
    await controller.ready(mock.res);
    expect(mock.statusCode).toBe(503);
  });

  test('只有软依赖（redis, critical:false）失败 → 200 degraded，checks 里仍能看到失败', async () => {
    const controller = setup(readinessIndicator('database', true), readinessIndicator('redis', false, false));
    const mock = mockRes();
    await controller.ready(mock.res);
    expect(mock.statusCode).toBe(200);
    expect(mock.body.status).toBe('degraded');
    const checks = mock.body.checks as Record<string, { healthy: boolean; error?: string }>;
    expect(checks.redis?.healthy).toBe(false);
    expect(checks.redis?.error).toBe('ECONNRESET');
    expect(checks.database?.healthy).toBe(true);
  });

  test('软依赖和硬依赖同时失败 → 503（硬依赖优先）', async () => {
    const controller = setup(readinessIndicator('database', false), readinessIndicator('redis', false, false));
    const mock = mockRes();
    await controller.ready(mock.res);
    expect(mock.statusCode).toBe(503);
    expect(mock.body.status).toBe('not_ready');
  });
});

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
