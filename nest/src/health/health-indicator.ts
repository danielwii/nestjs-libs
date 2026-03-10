/**
 * Health Indicator 接口
 *
 * 通过 NestJS multi-provider (HEALTH_INDICATOR token) 实现 auto-discovery：
 * 各 Module 注册 indicator，HealthController 自动收集并按 type 分组。
 *
 * - readiness: 检查自身依赖（DB、Redis），失败 → K8s 摘流量
 * - topology: 检查下游 gRPC 服务可达性，失败 → 仅告警，不影响 readiness
 */

export const HEALTH_INDICATOR = Symbol('HEALTH_INDICATOR');

export type HealthIndicatorType = 'readiness' | 'topology';

export interface HealthIndicatorResult {
  name: string;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthIndicator {
  readonly type: HealthIndicatorType;
  check(): Promise<HealthIndicatorResult>;
}
