import { Controller, Get, HttpStatus, Res } from '@nestjs/common';

import { shutdownState } from '@app/nest/boot/shutdown-state';
import { getAppLogger } from '@app/utils/app-logger';

import { HealthRegistry } from './health-registry';

import type { HealthIndicatorResult } from './health-indicator';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Health Controller
 *
 * 三层 K8s 健康检查端点，auto-discovery 通过 HealthRegistry 实现。
 *
 * 端点：
 * - GET /health          - liveness（进程活着）
 * - GET /health/ready    - readiness（自身 + DB + Redis），失败 → K8s 摘流量
 * - GET /health/topology - 下游 gRPC 可达性，失败 → 503（用于监控告警）
 *
 * 设计决策：
 * - /health/ready 不检查下游 gRPC — 避免级联故障
 * - /health/topology 不用于 K8s 探针，503 供监控工具告警
 * - topology 三档：ok（全通 200）/ degraded（部分不通 503）/ down（全挂 503）
 * - /health/ready 和 /health/topology 的 503 不走 exception 流程，直接 res.status().json()
 *   避免全局 AnyExceptionFilter 把预期的 503（shutdown / 降级）误报为 ERROR 并发送 Sentry
 */

@Controller('health')
export class HealthController implements OnApplicationShutdown {
  private readonly logger = getAppLogger('HealthController');
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
   *
   * 不走 exception 流程，直接设 status code 返回。
   * 避免 AnyExceptionFilter 把 shutdown 503 当 fatal error 发送 Sentry。
   */
  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    // shutdownState.value 在 Phase 1（SIGTERM 到达时）立即置 true，确保 K8s 尽早摘流量
    // this.isShuttingDown 在 Phase 4（app.close()）才置 true，单独依赖会导致 drain 期间漏流量
    if (this.isShuttingDown || shutdownState.value) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'shutting_down' });
      return;
    }

    const indicators = this.registry.getByType('readiness');
    if (indicators.length === 0) {
      res.status(HttpStatus.OK).json({ status: 'ready', checks: {} });
      return;
    }

    const results = await Promise.all(indicators.map((i) => i.check()));
    const checks: Record<string, HealthIndicatorResult> = {};
    for (const r of results) {
      checks[r.name] = r;
    }

    const allHealthy = results.every((r) => r.healthy);
    if (!allHealthy) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'not_ready', checks });
      return;
    }

    res.status(HttpStatus.OK).json({ status: 'ready', checks });
  }

  /**
   * Topology 端点 — 检查下游 gRPC 可达性
   *
   * 不走 exception 流程，直接设 status code 返回。
   * 避免全局 AnyExceptionFilter 把 topology 503 当 fatal error 打 ERROR 日志。
   *
   * - ok（200）：全部健康
   * - degraded（503）：部分不通（黄，P2）
   * - down（503）：全部不通（红，P1）
   */
  @Get('topology')
  async topology(@Res() res: Response): Promise<void> {
    const indicators = this.registry.getByType('topology');
    if (indicators.length === 0) {
      res.status(HttpStatus.OK).json({ status: 'ok', checks: {} });
      return;
    }

    // 总超时兜底：即使单个 indicator 的内部超时失效（如 gRPC channel reconnecting），
    // 也保证 topology 端点在 5 秒内返回，避免监控探测卡死。
    const TOPOLOGY_TIMEOUT_MS = 5000;
    let results: HealthIndicatorResult[];
    try {
      results = await Promise.race([
        Promise.all(indicators.map((i) => i.check())),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error(`topology timeout (${TOPOLOGY_TIMEOUT_MS}ms)`));
          }, TOPOLOGY_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warning`topology check failed: ${message}`;
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'down', error: message });
      return;
    }

    const checks: Record<string, HealthIndicatorResult> = {};
    for (const r of results) {
      checks[r.name] = r;
    }

    const healthyCount = results.filter((r) => r.healthy).length;
    if (healthyCount === results.length) {
      res.status(HttpStatus.OK).json({ status: 'ok', checks });
      return;
    }

    const status = healthyCount === 0 ? 'down' : 'degraded';
    res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status, checks });
  }

  onApplicationShutdown(_signal?: string): void {
    this.isShuttingDown = true;
  }
}
