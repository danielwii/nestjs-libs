/**
 * gRPC Client Module Factory
 *
 * 通用 DynamicModule 工厂，一行代码创建 gRPC client 模块 + 自动注册 topology health indicator。
 *
 * @example
 * import { createGrpcChannel, createMarsgateClients } from '@app/contract/clients';
 * import { createGrpcHealthCheckFn } from '@app/contract/clients/health';
 * import { GrpcClientModule } from '@app/nest/grpc';
 *
 * export const MARSGATE = 'MARSGATE_GRPC_CLIENTS';
 * export type { MarsgateClients } from '@app/contract/clients';
 *
 * export const MarsgateGrpcModule = GrpcClientModule.register({
 *   token: MARSGATE,
 *   name: 'marsgate',
 *   address: () => `${AppEnvs.MARSGATE_GRPC_HOST}:${AppEnvs.MARSGATE_GRPC_PORT}`,
 *   clientFactory: (addr) => createMarsgateClients(createGrpcChannel(addr)),
 *   healthCheckFactory: (addr) => createGrpcHealthCheckFn(createGrpcChannel, addr),
 * });
 */

import { Injectable, Module, Optional } from '@nestjs/common';

import { HealthRegistry } from '../health/health-registry';
import { createGrpcHealthIndicator } from '../health/indicators/grpc.health-indicator';

import { getAppLogger } from '@app/utils/app-logger';

import type { DynamicModule, OnModuleInit } from '@nestjs/common';

export interface GrpcClientModuleOptions<T = unknown> {
  /** NestJS provider token */
  token: string | symbol;
  /** 下游服务名称，用于日志和 health indicator（如 'marsgate'） */
  name: string;
  /** gRPC 服务地址（host:port），延迟求值避免启动顺序问题 */
  address: () => string;
  /** 业务客户端工厂：address → client（内部自行创建 channel） */
  clientFactory: (address: string) => T;
  /** 健康检查工厂：address → checkFn（内部自行创建独立 channel） */
  healthCheckFactory: (address: string) => () => Promise<boolean>;
}

@Module({})
export class GrpcClientModule {
  static register<T>(options: GrpcClientModuleOptions<T>): DynamicModule {
    const { token, name, address, clientFactory, healthCheckFactory } = options;

    // 为每个 register() 调用创建独立的 Initializer 类，
    // NestJS 会在 module init 阶段调用其 onModuleInit
    @Injectable()
    class GrpcClientInitializer implements OnModuleInit {
      private readonly logger = getAppLogger(`${name}GrpcModule`);

      // @Optional: CLI 路径不经过 bootstrap，无 HealthRegistry
      constructor(@Optional() private readonly healthRegistry: HealthRegistry | undefined) {}

      onModuleInit() {
        const addr = address();
        this.logger.info`${name} gRPC at ${addr}`;
        if (this.healthRegistry) {
          this.healthRegistry.register(createGrpcHealthIndicator(name, healthCheckFactory(addr)));
        }
      }
    }
    // 方便调试时识别
    Object.defineProperty(GrpcClientInitializer, 'name', { value: `${name}GrpcInitializer` });

    return {
      module: GrpcClientModule,
      providers: [
        GrpcClientInitializer,
        {
          provide: token,
          useFactory: () => clientFactory(address()),
        },
      ],
      exports: [token],
      global: true,
    };
  }
}
