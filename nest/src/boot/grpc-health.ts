/**
 * gRPC Health Service (服务端)
 *
 * 标准 gRPC Health Checking Protocol (grpc.health.v1) 实现。
 * 从 descriptor_set.bin 加载 Health service 定义，注册到 @grpc/grpc-js Server。
 *
 * - 正常状态返回 SERVING (1)
 * - shutdown 时返回 NOT_SERVING (2)
 *
 * 使用方式：在 grpcBootstrap 的 onLoadPackageDefinition 回调中调用。
 */

import fs from 'node:fs';

import { getAppLogger } from '@app/utils/app-logger';

import type { sendUnaryData, Server, ServerUnaryCall } from '@grpc/grpc-js';

// proto3 enum 值（wire format 是数字）
const SERVING = 1;
const NOT_SERVING = 2;

/**
 * 注册 gRPC Health Service 到 gRPC Server
 *
 * @param server @grpc/grpc-js Server 实例
 * @param descriptorSetPath 包含 health.proto 的 descriptor_set.bin 路径
 * @param isShuttingDown 返回当前是否在关闭中
 */
export function addGrpcHealthService(
  server: Pick<Server, 'addService'>,
  descriptorSetPath: string,
  isShuttingDown: () => boolean,
): void {
  try {
    // 动态 require，与 addDescriptorSetReflection 同模式
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
    const protoLoader: typeof import('@grpc/proto-loader') = require('@grpc/proto-loader');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
    const grpc: typeof import('@grpc/grpc-js') = require('@grpc/grpc-js');

    const protoset = fs.readFileSync(descriptorSetPath);
    const packageDef = protoLoader.loadFileDescriptorSetFromBuffer(protoset);
    const grpcObject = grpc.loadPackageDefinition(packageDef);

    // 导航到 grpc.health.v1.Health — grpcObject 是嵌套对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const healthService = (grpcObject as any)?.grpc?.health?.v1?.Health;
    const logger = getAppLogger('boot', 'gRPC-Health');

    if (!healthService?.service) {
      logger.warning`Health service definition not found in descriptor set`;
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    server.addService(healthService.service, {
      Check: (
        _call: ServerUnaryCall<{ service?: string }, { status: number }>,
        callback: sendUnaryData<{ status: number }>,
      ) => {
        const status = isShuttingDown() ? NOT_SERVING : SERVING;
        callback(null, { status });
      },
    });

    logger.info`gRPC Health service registered (grpc.health.v1.Health)`;
  } catch (err) {
    getAppLogger('boot', 'gRPC-Health').error`Failed to register gRPC Health service: ${err}`;
  }
}
