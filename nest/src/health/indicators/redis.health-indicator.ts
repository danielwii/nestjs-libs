/**
 * Redis Health Indicator
 *
 * 执行 PING 验证 Redis 连接是否可用。
 * 2 秒超时。
 */

import { errorMessage, rejectAfter } from './utils';

import type { HealthIndicator, HealthIndicatorResult } from '../health-indicator';

const TIMEOUT_MS = 2000;

export function createRedisHealthIndicator(pingFn: () => Promise<string>): HealthIndicator {
  return {
    type: 'readiness',
    async check(): Promise<HealthIndicatorResult> {
      const start = Date.now();
      try {
        const result = await Promise.race([pingFn(), rejectAfter(TIMEOUT_MS)]);
        return { name: 'redis', healthy: result === 'PONG', latencyMs: Date.now() - start };
      } catch (e) {
        return { name: 'redis', healthy: false, latencyMs: Date.now() - start, error: errorMessage(e) };
      }
    },
  };
}
