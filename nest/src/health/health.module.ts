import { Global, Module } from '@nestjs/common';

import { HealthRegistry } from './health-registry';
import { HealthController } from './health.controller';

/**
 * Health Module
 *
 * 提供标准化的 K8s 健康检查端点 + auto-discovery 机制。
 *
 * HealthRegistry 通过 @Global() 注入，各 Module 在 onModuleInit 时注册 indicator，
 * HealthController 自动按 type 分组收集。
 *
 * 端点：
 * - GET /health          - Liveness 探针
 * - GET /health/ready    - Readiness 探针（DB + Redis），失败返回 503
 * - GET /health/topology - 下游 gRPC 可达性，始终 200
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [HealthRegistry],
  exports: [HealthRegistry],
})
export class HealthModule {}
