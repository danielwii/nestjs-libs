/**
 * 模块级共享状态，用于 bootstrap → lifecycle 之间传递 shutdown 引用。
 * NestJS app 是 Proxy 对象，不支持直接设属性，所以用独立模块。
 */

/** gRPC health check 读取此值决定返回 SERVING / NOT_SERVING */
export const shutdownState = { value: false };

/**
 * bootstrap 保存 gRPC microservice 引用，lifecycle 用于 tryShutdown。
 *
 * 类型为 unknown 因为需要访问 NestJS 内部属性（serverInstance.grpcClient），
 * 这些不在公开接口上。lifecycle.ts 中通过运行时检查安全访问。
 */
export let grpcMicroserviceRef: unknown = undefined;

export function setGrpcMicroserviceRef(ref: unknown) {
  grpcMicroserviceRef = ref;
}
