import { Module } from '@nestjs/common';

import { HealthModule } from '@app/nest/health/health.module';
import { TraceModule } from '@app/nest/trace/trace.module';

import { InitializableModule } from './initializable.module';

/**
 * Boot Module
 *
 * 启动必备的基础设施模块，包含：
 * - TraceModule: 自动注入 traceId 到日志
 * - HealthModule: K8s 健康检查端点 (/health, /health/ready)
 *
 * 使用方式：
 * ```typescript
 * import { BootModule } from '@app/nest/boot';
 *
 * @Module({
 *   imports: [BootModule],
 * })
 * export class AppModule {}
 * ```
 *
 * 端点：
 * - GET /health       - Liveness 探针
 * - GET /health/ready - Readiness 探针（优雅关闭时返回 503）
 */
@Module({
  imports: [TraceModule, HealthModule],
})
export class BootModule extends InitializableModule {}
