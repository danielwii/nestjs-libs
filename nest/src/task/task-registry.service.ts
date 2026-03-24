import { Injectable } from '@nestjs/common';

import { getAppLogger } from '@app/utils/app-logger';

import type { BeforeApplicationShutdown } from '@nestjs/common';

// ==================== Types ====================

export interface TaskRunOptions {
  /** 任务超时，单位 ms，默认 60_000 */
  timeoutMs?: number;
}

/** 传递给任务函数的上下文 */
export interface TaskContext {
  /** 超时或 shutdown 时会 abort */
  signal: AbortSignal;
}

export type TaskFn = (ctx: TaskContext) => Promise<void>;

interface RunningTask {
  name: string;
  promise: Promise<void>;
  controller: AbortController;
}

// ==================== Service ====================

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 任务注册表 — 追踪运行中的任务，提供超时控制和 graceful drain
 *
 * 设计参考 ConnectionManagerService（Set 追踪 + isShuttingDown + beforeApplicationShutdown）。
 *
 * 使用方式：
 * ```typescript
 * @Cron(CronExpression.EVERY_MINUTE, { name: 'sync-devices' })
 * async handleCron(): Promise<void> {
 *   await this.taskRegistry.run('sync-devices', async ({ signal }) => {
 *     // signal: AbortSignal — 超时或 shutdown 时自动 abort
 *     await this.deviceService.syncAll({ signal });
 *   }, { timeoutMs: 45_000 });
 * }
 * ```
 *
 * Shutdown 行为：
 * 1. 新任务被拒绝（跳过 + warning）
 * 2. 等待所有运行中任务完成（每个任务已有独立超时，drain 无需额外超时）
 */
@Injectable()
export class TaskRegistryService implements BeforeApplicationShutdown {
  private readonly logger = getAppLogger('TaskRegistry');
  private readonly runningTasks = new Set<RunningTask>();
  private _shuttingDown = false;

  /**
   * 执行一个受管理的任务
   *
   * - shutdown 中：跳过 + warning
   * - 超时：abort signal + error 日志（非预期，业务出问题了）
   * - fn 异常：捕获 + error 日志（不抛给调用者）
   * - 完成后自动清理
   */
  async run(name: string, fn: TaskFn, opts?: TaskRunOptions): Promise<void> {
    if (this._shuttingDown) {
      this.logger.warning`#run skipped (shutting down): ${name}`;
      return;
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      this.logger.error`#run timeout (${timeoutMs}ms): ${name}`;
      controller.abort(new Error(`Task "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const entry: RunningTask = { name, promise: Promise.resolve(), controller };

    const taskPromise = fn({ signal: controller.signal })
      .catch((err: unknown) => {
        // 超时触发的 AbortError 已在 setTimeout 回调打过 error 日志
        if (!controller.signal.aborted) {
          this.logger.error`#run failed: ${name} ${err}`;
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        this.runningTasks.delete(entry);
        this.logger.debug`#run completed: ${name} remaining=${this.runningTasks.size}`;
      });

    entry.promise = taskPromise;
    this.runningTasks.add(entry);
    this.logger.debug`#run started: ${name} running=${this.runningTasks.size}`;

    await taskPromise;
  }

  /** 是否正在关闭 */
  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  /** 当前运行中的任务数 */
  get activeTaskCount(): number {
    return this.runningTasks.size;
  }

  /**
   * NestJS shutdown 钩子 — 等待所有运行中任务完成
   *
   * 每个任务已有独立超时（默认 60s），drain 无需额外超时上限。
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this._shuttingDown = true;
    const count = this.runningTasks.size;

    if (count === 0) {
      this.logger.info`#beforeApplicationShutdown signal=${signal ?? 'unknown'} no running tasks`;
      return;
    }

    this.logger.info`#beforeApplicationShutdown signal=${signal ?? 'unknown'} waiting for ${count} tasks...`;

    const promises = Array.from(this.runningTasks).map((t) => t.promise);
    await Promise.allSettled(promises);

    this.logger.info`#beforeApplicationShutdown all tasks drained`;
  }
}
