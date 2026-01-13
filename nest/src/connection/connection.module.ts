import { Global, Module } from '@nestjs/common';

import { ConnectionManagerService } from './connection-manager.service';

/**
 * Connection Module
 *
 * 提供长连接（SSE、WebSocket）的集中管理和优雅关闭能力。
 *
 * 使用方式：
 * 1. 模块已通过 BootModule 全局注入，无需手动导入
 * 2. 在需要的地方注入 ConnectionManagerService
 *
 * ```typescript
 * @Injectable()
 * export class SsePresenter {
 *   constructor(private readonly connectionManager: ConnectionManagerService) {}
 *
 *   open(res: Response, userId?: string): void {
 *     this.connectionManager.registerSSE(res, userId);
 *     // ... SSE 逻辑
 *   }
 * }
 * ```
 *
 * 优雅关闭流程：
 * - K8s 发送 SIGTERM
 * - ConnectionManagerService.beforeApplicationShutdown 被调用
 * - 所有 SSE 连接收到 'server_restart' 事件
 * - 客户端可以立即重连到新 Pod
 */
@Global()
@Module({
  providers: [ConnectionManagerService],
  exports: [ConnectionManagerService],
})
export class ConnectionModule {}
