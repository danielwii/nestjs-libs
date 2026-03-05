/**
 * GrpcServiceTokenGuard
 *
 * 验证 gRPC 请求中的服务间共享密钥。
 * 通过 gRPC metadata 的 `x-service-token` 字段传递。
 *
 * 使用方式：
 *
 * 1. 环境变量配置（Doppler 注入）：
 *    GRPC_SERVICE_TOKEN=<shared-secret>
 *
 * 2. 服务端（NestJS gRPC Controller）：
 *    ```
 *    @UseGuards(GrpcServiceTokenGuard)
 *    @Controller()
 *    export class MyGrpcController { ... }
 *    ```
 *
 * 3. 客户端（nice-grpc）：
 *    ```
 *    const metadata = Metadata();
 *    metadata.set('x-service-token', process.env.GRPC_SERVICE_TOKEN);
 *    client.someMethod(request, { metadata });
 *    ```
 *
 * 安全模型：
 * - 未配置 GRPC_SERVICE_TOKEN 时，跳过验证（本地开发兼容）
 * - 配置后，缺少或错误的 token 返回 UNAUTHENTICATED
 */

import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { status } from '@grpc/grpc-js';

import type { Metadata } from '@grpc/grpc-js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

const SERVICE_TOKEN_KEY = 'x-service-token';

@Injectable()
export class GrpcServiceTokenGuard implements CanActivate {
  private readonly logger = new Logger(GrpcServiceTokenGuard.name);
  private loggedSkipOnce = false;

  canActivate(context: ExecutionContext): boolean {
    const expectedToken = process.env.GRPC_SERVICE_TOKEN;

    // 未配置 token 时跳过验证（本地开发）
    if (!expectedToken) {
      if (!this.loggedSkipOnce) {
        this.logger.warn('#canActivate GRPC_SERVICE_TOKEN not configured, skipping auth (local dev mode)');
        this.loggedSkipOnce = true;
      }
      return true;
    }

    const rpcContext = context.switchToRpc().getContext<Metadata>();
    const tokenValues = rpcContext.get(SERVICE_TOKEN_KEY);
    const token = tokenValues.length > 0 ? String(tokenValues[0]) : undefined;

    if (!token) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Missing service token in gRPC metadata',
      });
    }

    if (token !== expectedToken) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Invalid service token',
      });
    }

    return true;
  }
}
