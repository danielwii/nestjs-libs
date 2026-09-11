/**
 * Redis Health Indicator
 *
 * 执行 PING 验证 Redis 连接是否可用。
 * 2 秒超时。
 *
 * 缺省为 **软依赖**（critical: false）：Redis 不可用时 readiness 仍返回 200，
 * body.status = 'degraded'。理由见 health-indicator.ts 头注释（2026-09-11：Redis 单点
 * 重启让 thirdparty / marsgate 全部副本同时摘流）。真把 Redis 当硬依赖的服务
 * 显式传 `{ critical: true }`。
 */

import { errorMessage, rejectAfter } from './utils';

import type { HealthIndicator, HealthIndicatorResult } from '../health-indicator';

const TIMEOUT_MS = 2000;

export interface RedisHealthIndicatorOptions {
  /** 缺省 false（软依赖）。 */
  critical?: boolean;
}

export function createRedisHealthIndicator(
  pingFn: () => Promise<string>,
  options: RedisHealthIndicatorOptions = {},
): HealthIndicator {
  return {
    type: 'readiness',
    critical: options.critical ?? false,
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
