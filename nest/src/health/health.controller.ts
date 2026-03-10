import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { HealthRegistry } from './health-registry';

import type { HealthIndicatorResult } from './health-indicator';
import type { OnApplicationShutdown } from '@nestjs/common';

/**
 * Health Controller
 *
 * 三层 K8s 健康检查端点，auto-discovery 通过 HealthRegistry 实现。
 *
 * 端点：
 * - GET /health          - liveness（进程活着）
 * - GET /health/ready    - readiness（自身 + DB + Redis），失败 → K8s 摘流量
 * - GET /health/topology - 下游 gRPC 可达性，始终 HTTP 200，body 标 ok/degraded
 *
 * 设计决策：
 * - /health/ready 不检查下游 gRPC — 避免级联故障
 * - /health/topology 始终 HTTP 200 — 只用于告警，不影响 K8s 探针
 */
@Controller('health')
export class HealthController implements OnApplicationShutdown {
  private isShuttingDown = false;

  constructor(private readonly registry: HealthRegistry) {}

  /**
   * Liveness 探针 — 进程活着就返回 200
   */
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness 探针 — 检查自身依赖（DB、Redis），shutdown 时返回 503
   */
  @Get('ready')
  async ready(): Promise<{ status: string; checks: Record<string, HealthIndicatorResult> }> {
    if (this.isShuttingDown) {
      throw new ServiceUnavailableException('Shutting down');
    }

    const indicators = this.registry.getByType('readiness');
    if (indicators.length === 0) {
      return { status: 'ready', checks: {} };
    }

    const results = await Promise.all(indicators.map((i) => i.check()));
    const checks: Record<string, HealthIndicatorResult> = {};
    for (const r of results) {
      checks[r.name] = r;
    }

    const allHealthy = results.every((r) => r.healthy);
    if (!allHealthy) {
      throw new ServiceUnavailableException({ status: 'not_ready', checks });
    }

    return { status: 'ready', checks };
  }

  /**
   * Topology 端点 — 检查下游 gRPC 可达性
   *
   * 始终返回 HTTP 200（不影响 K8s 探针），body 标 ok/degraded。
   */
  @Get('topology')
  async topology(): Promise<{ status: string; checks: Record<string, HealthIndicatorResult> }> {
    const indicators = this.registry.getByType('topology');
    if (indicators.length === 0) {
      return { status: 'ok', checks: {} };
    }

    const results = await Promise.all(indicators.map((i) => i.check()));
    const checks: Record<string, HealthIndicatorResult> = {};
    for (const r of results) {
      checks[r.name] = r;
    }

    const allHealthy = results.every((r) => r.healthy);
    return { status: allHealthy ? 'ok' : 'degraded', checks };
  }

  onApplicationShutdown(_signal?: string): void {
    this.isShuttingDown = true;
  }
}
