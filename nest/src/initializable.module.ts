import { Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { DateTime } from 'luxon';

import { Trace } from '@app/trace';
import { f } from '@app/utils';

export interface InitializationOptions {
  timeout?: number;
  moduleName?: string;
}

export abstract class InitializableModule implements OnModuleInit, OnApplicationBootstrap {
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
    // if (this.initialize === InitializableModule.prototype.initialize) {
    //   this.logger.debug(`#onModuleInit initialized`);
    //   return;
    // }

    this.logger.debug(`#onModuleInit initializing...`);

    try {
      // 设置超时检查
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`[${this.moduleName}] #onModuleInit timeout, over ${this.timeout.toLocaleString()}s`));
        }, this.timeout * 1000);
      });

      // 等待初始化完成或超时
      await Promise.race([this.initialize(), timeoutPromise]);

      const endTime = DateTime.now();
      const duration = endTime.diff(this.startTime);

      this.logger.debug(f`#onModuleInit initialized in ${duration.toHuman()}`);
    } catch (error: unknown) {
      this.logger.error(
        `#onModuleInit failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  protected abstract initialize(): Promise<void>;

  @Trace()
  async onApplicationBootstrap() {
    // 检查子类是否实现了 onBootstrap
    if (this.onBootstrap === InitializableModule.prototype.onBootstrap) {
      return;
    }

    const startTime = DateTime.now();
    this.logger.debug(`#onApplicationBootstrap bootstraping...`);
    await this.onBootstrap();
    const endTime = DateTime.now();
    const duration = endTime.diff(startTime);
    this.logger.debug(`#onApplicationBootstrap bootstraped in ${duration.toHuman()}`);
  }

  protected async onBootstrap(): Promise<void> {
    // 默认空实现
  }
}
