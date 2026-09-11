/**
 * Health Indicator 接口
 *
 * 通过 NestJS multi-provider (HEALTH_INDICATOR token) 实现 auto-discovery：
 * 各 Module 注册 indicator，HealthController 自动收集并按 type 分组。
 *
 * - readiness: 检查自身依赖（DB、Redis），critical 的失败 → K8s 摘流量；
 *   non-critical 的失败 → 仍然 ready，只在 body 里标 degraded
 * - topology: 检查下游 gRPC 服务可达性，失败 → 仅告警，不影响 readiness
 *
 * 为什么要区分 critical（2026-09-11 生产事故）：
 * 单副本 Redis 被节点轮换驱逐重启的 20 秒里，thirdparty / marsgate 的全部副本
 * 同时 readiness 失败 → 网关上两个服务零可用端点。Redis 对这些服务只是缓存
 * （provider 已能回落内存缓存），把它当硬依赖等于让一个软依赖的抖动变成整服务停摆。
 * readiness 只该表达「这个进程现在能不能接请求」，不该表达「所有依赖都完美」。
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
  /**
   * 仅对 readiness 有意义。true / 缺省 = 硬依赖（失败即 503 摘流）；
   * false = 软依赖（失败仍 200，body.status = 'degraded'）。
   */
  readonly critical?: boolean;
  check(): Promise<HealthIndicatorResult>;
}
