/**
 * Health Indicator — Port 定义
 *
 * DDD 分层：Port（接口层）
 * 各 Adapter（Redis、Prisma）实现 HealthIndicator 并注册到 HealthRegistry。
 *
 * K8s 三层探针：
 * - liveness:  进程活着（无需 indicator）
 * - readiness: 自身依赖（DB、Redis），失败 → K8s 摘流量
 * - topology:  下游服务可达性，失败 → 告警
 */

export type HealthIndicatorType = 'readiness' | 'topology';

export interface HealthIndicatorResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface HealthIndicator {
  readonly type: HealthIndicatorType;
  readonly check: () => Promise<HealthIndicatorResult>;
}

// ==================== Factory Functions ====================

const TIMEOUT_MS = 2000;

const rejectAfter = (ms: number): Promise<never> =>
  new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Health check timeout (${ms}ms)`));
    }, ms);
  });

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** DB readiness indicator: SELECT 1 with 2s timeout */
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

/** Redis readiness indicator: PING with 2s timeout */
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
