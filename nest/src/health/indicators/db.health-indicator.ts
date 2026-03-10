/**
 * Database Health Indicator
 *
 * 执行一个简单查询验证数据库连接是否可用。
 * 2 秒超时，避免慢查询阻塞 readiness 探针。
 */

import { errorMessage, rejectAfter } from './utils';

import type { HealthIndicator, HealthIndicatorResult } from '../health-indicator';

const TIMEOUT_MS = 2000;

export function createDbHealthIndicator(queryFn: () => Promise<unknown>): HealthIndicator {
  return {
    type: 'readiness',
    async check(): Promise<HealthIndicatorResult> {
      const start = Date.now();
      try {
        await Promise.race([queryFn(), rejectAfter(TIMEOUT_MS)]);
        return { name: 'database', healthy: true, latencyMs: Date.now() - start };
      } catch (e) {
        return { name: 'database', healthy: false, latencyMs: Date.now() - start, error: errorMessage(e) };
      }
    },
  };
}
