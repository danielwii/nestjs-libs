import { Module } from '@nestjs/common';

import { ConnectionModule } from '@app/nest/connection/connection.module';
import { HealthModule } from '@app/nest/health/health.module';
import { SentryDebugModule } from '@app/nest/sentry-debug/sentry-debug.module';

import { InitializableModule } from './initializable.module';

/**
 * Boot Module
 *
 * 启动必备的基础设施模块，包含：
 * - HealthModule: K8s 健康检查端点 (/health, /health/ready)
 * - ConnectionModule: 长连接管理和优雅关闭
 *
 * 日志通过 LogtapeNestLogger 在 bootstrap 阶段注入，不再需要 TraceModule。
 *
 * 端点：
 * - GET /health       - Liveness 探针
 * - GET /health/ready - Readiness 探针（优雅关闭时返回 503）
 */
@Module({
  imports: [HealthModule, ConnectionModule, SentryDebugModule],
})
export class BootModule extends InitializableModule {}
