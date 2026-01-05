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
 * 使用方式：
 * ```typescript
 * import { HealthModule } from '@app/nest/health';
 *
 * @Module({
 *   imports: [HealthModule],
 * })
 * export class AppModule {}
 * ```
 */
@Controller('health')
export class HealthController implements OnApplicationShutdown {
  private isShuttingDown = false;

  /**
   * 基础健康检查
   * 用于 Startup 和 Liveness 探针。
   */
  @Get()
  health() {
    return { status: 'ok' };
  }

  /**
   * 就绪检查
   * 用于 Readiness 探针，关闭中返回 503 实现流量排空。
   */
  @Get('ready')
  ready() {
    if (this.isShuttingDown) {
      throw new ServiceUnavailableException('Shutting down');
    }
    return { status: 'ready' };
  }

  onApplicationShutdown(_signal?: string) {
    this.isShuttingDown = true;
  }
}
