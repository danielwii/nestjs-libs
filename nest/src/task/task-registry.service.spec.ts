import { TaskRegistryService } from './task-registry.service';

import { describe, expect, it } from 'bun:test';

function createRegistry(): TaskRegistryService {
  return new TaskRegistryService();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

describe('TaskRegistryService', () => {
  it('正常执行：fn 被调用，activeTaskCount 先增后减', async () => {
    const registry = createRegistry();
    let called = false;

    await registry.run('test-task', async () => {
      called = true;
      expect(registry.activeTaskCount).toBe(1);
    });

    expect(called).toBe(true);
    expect(registry.activeTaskCount).toBe(0);
  });

  it('超时 abort：signal.aborted === true + 任务被终止', async () => {
    const registry = createRegistry();
    let aborted = false;

    await registry.run(
      'slow-task',
      async ({ signal }) => {
        await sleep(5000, signal).catch(() => {
          aborted = true;
        });
      },
      { timeoutMs: 50 },
    );

    expect(aborted).toBe(true);
    expect(registry.activeTaskCount).toBe(0);
  });

  it('shutdown 拒绝新任务：fn 不被调用', async () => {
    const registry = createRegistry();
    let called = false;

    // 触发 shutdown
    await registry.beforeApplicationShutdown('SIGTERM');

    await registry.run('rejected-task', async () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(registry.shuttingDown).toBe(true);
  });

  it('shutdown 等待运行中任务完成', async () => {
    const registry = createRegistry();
    let taskFinished = false;

    // 启动一个耗时任务（不 await）
    const taskPromise = registry.run('long-task', async () => {
      await sleep(100);
      taskFinished = true;
    });

    expect(registry.activeTaskCount).toBe(1);

    // 触发 shutdown — 应该等到任务完成
    const shutdownPromise = registry.beforeApplicationShutdown('SIGTERM');

    await Promise.all([taskPromise, shutdownPromise]);

    expect(taskFinished).toBe(true);
    expect(registry.activeTaskCount).toBe(0);
  });

  it('并发任务追踪：activeTaskCount 正确', async () => {
    const registry = createRegistry();

    const task1 = registry.run('task-1', async () => {
      await sleep(50);
    });
    const task2 = registry.run('task-2', async () => {
      await sleep(50);
    });
    const task3 = registry.run('task-3', async () => {
      await sleep(50);
    });

    expect(registry.activeTaskCount).toBe(3);

    await Promise.all([task1, task2, task3]);

    expect(registry.activeTaskCount).toBe(0);
  });

  it('fn 抛异常：错误被捕获，不抛到调用者', async () => {
    const registry = createRegistry();

    // 不应该抛出
    await registry.run('failing-task', async () => {
      throw new Error('business error');
    });

    expect(registry.activeTaskCount).toBe(0);
  });

  it('shuttingDown 初始为 false', () => {
    const registry = createRegistry();
    expect(registry.shuttingDown).toBe(false);
  });

  it('beforeApplicationShutdown 无任务时立即返回', async () => {
    const registry = createRegistry();
    await registry.beforeApplicationShutdown('SIGTERM');
    expect(registry.shuttingDown).toBe(true);
  });
});
