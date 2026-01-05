import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import type { OnApplicationShutdown } from '@nestjs/common';

/**
 * Health Controller
 *
 * 提供 K8s 健康检查端点，支持优雅关闭时主动返回 503。
 *
 * 端点：
 * - GET /health       - 基础健康检查（Startup/Liveness 探针）
 * - GET /health/ready - 就绪检查（Readiness 探针），关闭时返回 503
 *
 * K8s 配置示例：
 * ```yaml
 * livenessProbe:
 *   httpGet:
 *     path: /health
 *     port: 3000
 *   initialDelaySeconds: 10
 *   periodSeconds: 10
 *
 * readinessProbe:
 *   httpGet:
 *     path: /health/ready
 *     port: 3000
 *   initialDelaySeconds: 5
 *   periodSeconds: 5
 * ```
 */
@Controller('health')
export class HealthController implements OnApplicationShutdown {
  private isShuttingDown = false;

  /**
   * 基础健康检查
   *
   * 用于 Startup 和 Liveness 探针。
   * 只要进程活着就返回 200，不检查依赖服务状态。
   */
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * 就绪检查
   *
   * 用于 Readiness 探针。
   * - 正常时返回 200，表示可以接收流量
   * - 关闭中返回 503，让 K8s 从 Service Endpoints 移除此 Pod
   *
   * 设计意图：配合 preStop hook 的 sleep，在 SIGTERM 后立即标记 NotReady，
   * 让 K8s 更快地将流量从此 Pod 移走。
   */
  @Get('ready')
  ready(): { status: string } {
    if (this.isShuttingDown) {
      throw new ServiceUnavailableException('Shutting down');
    }
    return { status: 'ready' };
  }

  /**
   * 应用关闭钩子
   *
   * NestJS 收到 SIGTERM 后会调用此方法。
   * 标记 isShuttingDown 后，后续 /health/ready 请求都会返回 503。
   */
  onApplicationShutdown(_signal?: string): void {
    this.isShuttingDown = true;
  }
}
