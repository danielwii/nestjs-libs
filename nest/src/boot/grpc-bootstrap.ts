import { getAppLogger } from '@app/utils/app-logger';

import fs from 'node:fs';

import * as protoLoader from '@grpc/proto-loader';
import { ServerReflection, ServerReflectionService } from 'nice-grpc-server-reflection';

import type { Server, ServerDuplexStream } from '@grpc/grpc-js';

/**
 * 将 @grpc/grpc-js 的 bidi stream 转为 AsyncIterable
 * 用于适配 nice-grpc 的 async generator 接口
 */
function callToAsyncIterable<T>(call: {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}): AsyncIterable<T> {
  const queue: Array<{ value: T; done: false } | { value: undefined; done: true }> = [];
  let resolve: ((v: { value: T; done: false } | { value: undefined; done: true }) => void) | null = null;

  call.on('data', (data: unknown) => {
    const item = { value: data as T, done: false as const };
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  });

  call.on('end', () => {
    const item = { value: undefined, done: true as const };
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const queued = queue.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

/**
 * 从 FileDescriptorSet 二进制中提取所有 service 全限定名
 * 使用 @grpc/proto-loader 解析，从 PackageDefinition 中提取 service 路径
 */
function extractServiceNames(protoset: Buffer): string[] {
  const pkg = protoLoader.loadFileDescriptorSetFromBuffer(protoset);
  const serviceNames = new Set<string>();
  for (const key of Object.keys(pkg)) {
    const def = pkg[key];
    // service definition 是对象且不含 requestStream（区分 service 和 method）
    if (def && typeof def === 'object' && !('requestStream' in def)) {
      serviceNames.add(key);
    }
  }
  return [...serviceNames];
}

/**
 * 将预编译 descriptor set 注册为 gRPC reflection service
 * 使用 nice-grpc-server-reflection 直接服务原始字节，绕过 protobufjs roundtrip bug
 */
export function addDescriptorSetReflection(server: Pick<Server, 'addService'>, descriptorSetPath: string): void {
  const protoset = fs.readFileSync(descriptorSetPath);
  const serviceNames = extractServiceNames(protoset);
  const impl = ServerReflection(protoset, serviceNames);

  // nice-grpc ServiceDefinition → @grpc/grpc-js addService 需要类型断言
  // nice-grpc 的 async generator handler → @grpc/grpc-js 的 bidi stream callback
  server.addService(ServerReflectionService, {
    serverReflectionInfo: (call: ServerDuplexStream<unknown, unknown>) => {
      void (async () => {
        try {
          const requests = callToAsyncIterable(call);
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
          for await (const response of impl.serverReflectionInfo(requests as any, {} as any)) {
            call.write(response);
          }
        } catch (err) {
          getAppLogger('boot', 'gRPC-Reflection').error`Reflection error: ${err}`;
        } finally {
          call.end();
        }
      })();
    },
  });
}
