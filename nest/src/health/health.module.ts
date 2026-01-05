import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * Health Module
 *
 * 提供标准化的 K8s 健康检查端点。
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
 *
 * 端点：
 * - GET /health       - Liveness 探针
 * - GET /health/ready - Readiness 探针（优雅关闭时返回 503）
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
