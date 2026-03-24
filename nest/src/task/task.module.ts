import { Global, Module } from '@nestjs/common';

import { TaskRegistryService } from './task-registry.service';

/**
 * Task Module
 *
 * 提供任务追踪和优雅排空能力，通过 BootModule 全局注入。
 *
 * 使用方式：
 * 1. 模块已通过 BootModule 全局注入，无需手动导入
 * 2. 在需要的地方注入 TaskRegistryService
 *
 * ```typescript
 * @Injectable()
 * export class MyScheduler {
 *   constructor(private readonly taskRegistry: TaskRegistryService) {}
 *
 *   @Cron(CronExpression.EVERY_MINUTE, { name: 'my-task' })
 *   async handleCron(): Promise<void> {
 *     await this.taskRegistry.run('my-task', async ({ signal }) => {
 *       // 业务逻辑，signal 超时或 shutdown 时自动 abort
 *     });
 *   }
 * }
 * ```
 */
@Global()
@Module({
  providers: [TaskRegistryService],
  exports: [TaskRegistryService],
})
export class TaskModule {}
