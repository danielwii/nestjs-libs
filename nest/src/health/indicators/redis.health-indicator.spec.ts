import { createRedisHealthIndicator } from './redis.health-indicator';

import { describe, expect, test } from 'bun:test';

describe('createRedisHealthIndicator — critical flag', () => {
  test('缺省是软依赖（critical: false）', () => {
    const indicator = createRedisHealthIndicator(async () => 'PONG');
    expect(indicator.type).toBe('readiness');
    expect(indicator.critical).toBe(false);
  });

  test('显式 { critical: true } 时是硬依赖', () => {
    const indicator = createRedisHealthIndicator(async () => 'PONG', { critical: true });
    expect(indicator.critical).toBe(true);
  });

  test('PONG → healthy；非 PONG → unhealthy', async () => {
    const pong = await createRedisHealthIndicator(async () => 'PONG').check();
    expect(pong).toMatchObject({ name: 'redis', healthy: true });
    const loading = await createRedisHealthIndicator(async () => 'LOADING').check();
    expect(loading).toMatchObject({ name: 'redis', healthy: false });
  });

  test('ping 抛错 → unhealthy 且带 error，不向上抛', async () => {
    const result = await createRedisHealthIndicator(async () => {
      throw new Error('ECONNRESET');
    }).check();
    expect(result.healthy).toBe(false);
    expect(result.error).toContain('ECONNRESET');
  });
});
