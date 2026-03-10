import { ServiceUnavailableException } from '@nestjs/common';

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

// ==================== Tests ====================

describe('HealthController /health/topology', () => {
  test('无 indicator → 200 ok', async () => {
    const controller = setup();
    const result = await controller.topology();
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({});
  });

  test('全部健康 → 200 ok', async () => {
    const controller = setup(
      mockIndicator('grpc:ai-persona', true),
      mockIndicator('grpc:marsgate', true),
      mockIndicator('grpc:thirdparty', true),
    );
    const result = await controller.topology();
    expect(result.status).toBe('ok');
    expect(result.checks['grpc:ai-persona']?.healthy).toBe(true);
    expect(result.checks['grpc:marsgate']?.healthy).toBe(true);
    expect(result.checks['grpc:thirdparty']?.healthy).toBe(true);
  });

  test('部分不通 → 503 degraded（黄）', async () => {
    const controller = setup(
      mockIndicator('grpc:ai-persona', true),
      mockIndicator('grpc:marsgate', false),
      mockIndicator('grpc:thirdparty', true),
    );
    try {
      await controller.topology();
      throw new Error('Expected 503');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      const body = (e as ServiceUnavailableException).getResponse() as any;
      expect(body.status).toBe('degraded');
      expect(body.checks['grpc:marsgate']?.healthy).toBe(false);
      expect(body.checks['grpc:ai-persona']?.healthy).toBe(true);
    }
  });

  test('全部不通 → 503 down（红）', async () => {
    const controller = setup(
      mockIndicator('grpc:ai-persona', false),
      mockIndicator('grpc:marsgate', false),
      mockIndicator('grpc:thirdparty', false),
    );
    try {
      await controller.topology();
      throw new Error('Expected 503');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      const body = (e as ServiceUnavailableException).getResponse() as any;
      expect(body.status).toBe('down');
      expect(body.checks['grpc:ai-persona']?.healthy).toBe(false);
    }
  });
});
