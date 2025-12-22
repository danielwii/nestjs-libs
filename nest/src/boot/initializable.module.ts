import { Logger } from '@nestjs/common';

import { Trace } from '@app/nest/trace';
import { f } from '@app/utils/logging';

import { DateTime } from 'luxon';

import type { OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

export interface InitializationOptions {
  timeout?: number;
  moduleName?: string;
}

export abstract class InitializableModule
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap, OnApplicationShutdown
{
  protected readonly logger: Logger;
  protected readonly startTime: DateTime;
  protected readonly timeout: number;
  protected readonly moduleName: string;

  constructor(options: InitializationOptions = {}) {
    this.timeout = options.timeout ?? 30;
    this.moduleName = options.moduleName ?? this.constructor.name;
    this.logger = new Logger(this.moduleName);
    this.startTime = DateTime.now();
  }

  @Trace()
  async onModuleInit() {
    if (this.initialize === InitializableModule.prototype.initialize) {
      this.logger.debug(`#onModuleInit initialized`);
      return;
    }

    this.logger.debug(`#initialize initializing...`);

    try {
      // 设置超时检查
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Initialization timeout, over ${this.timeout.toLocaleString()}s, set larger timeout in domain constructor.`,
            ),
          );
        }, this.timeout * 1000);
      });

      // 等待初始化完成或超时
      await Promise.race([this.initialize(), timeoutPromise]);

      const endTime = DateTime.now();
      const duration = endTime.diff(this.startTime);

      this.logger.debug(f`#initialize initialized in ${duration.rescale().toHuman()}`);
    } catch (error: unknown) {
      this.logger.error(
        `#initialize failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  protected async initialize(): Promise<void> {}
  protected async onDispose(): Promise<void> {}

  private destroying = false;

  @Trace()
  async onModuleDestroy() {
    if (this.onDispose === InitializableModule.prototype.onDispose) {
      return;
    }
    if (this.destroying) {
      return;
    }
    this.destroying = true;
    this.logger.verbose('#onDispose destroying ...');
    await this.onDispose();
    this.logger.debug('#onDispose disposed.');
  }

  @Trace()
  async onApplicationBootstrap() {
    // 检查子类是否实现了 onBootstrap
    if (this.onBootstrap === InitializableModule.prototype.onBootstrap) {
      return;
    }

    const startTime = DateTime.now();
    this.logger.debug(`#onBootstrap bootstraping...`);
    await this.onBootstrap();
    const endTime = DateTime.now();
    const duration = endTime.diff(startTime);
    this.logger.debug(`#onBootstrap bootstraped in ${duration.toHuman()}`);
  }

  protected async onBootstrap(): Promise<void> {
    /* 默认空实现 */
  }

  @Trace()
  async onApplicationShutdown(signal?: string) {
    // 检查子类是否实现了 onBootstrap
    if (this.onShutdown === InitializableModule.prototype.onShutdown) {
      return;
    }

    const startTime = DateTime.now();
    this.logger.debug(f`#onShutdown bootstraping... ${{ signal }}`);
    await this.onShutdown();
    const endTime = DateTime.now();
    const duration = endTime.diff(startTime);
    this.logger.debug(`#onShutdown bootstraped in ${duration.toHuman()}`);
  }

  protected async onShutdown() {
    /* 默认空实现 */
  }
}
