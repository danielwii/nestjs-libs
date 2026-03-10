/**
 * gRPC Health Indicator
 *
 * 通用 gRPC 健康检查工厂，接受一个 checkFn 避免 libs 依赖 contract。
 * 实际的 gRPC health client 创建由 contract 提供 (createGrpcHealthCheckFn)。
 *
 * 用于 topology 端点，不影响 readiness。
 * checkFn 应自行处理超时（推荐 3 秒 deadline）。
 */

import type { HealthIndicator, HealthIndicatorResult } from '../health-indicator';

/**
 * @param name - 下游服务名称（如 'ai-persona', 'marsgate'），将显示为 'grpc:{name}'
 * @param checkFn - 健康检查函数，返回 true 表示健康。应包含超时控制。
 */
export function createGrpcHealthIndicator(name: string, checkFn: () => Promise<boolean>): HealthIndicator {
  return {
    type: 'topology',
    async check(): Promise<HealthIndicatorResult> {
      const start = Date.now();
      try {
        const healthy = await checkFn();
        return { name: `grpc:${name}`, healthy, latencyMs: Date.now() - start };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { name: `grpc:${name}`, healthy: false, latencyMs: Date.now() - start, error };
      }
    },
  };
}
