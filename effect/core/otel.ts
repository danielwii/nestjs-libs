/**
 * Effect OpenTelemetry 集成
 *
 * 设计意图：
 * - @effect/opentelemetry 桥接现有 OTel SDK
 * - Effect span 自动注册为 OTel span
 * - 与 libs/nest/src/trace 的 OTel 配置兼容（同一个 TracerProvider）
 *
 * 架构：
 * - libs/instrument.ts 已有 OTel SDK 初始化（NodeSDK）
 * - 这里只做 Effect ↔ OTel 桥接，不重新初始化 SDK
 */

import { NodeSdk, Resource, Tracer } from '@effect/opentelemetry';
import { Layer } from 'effect';

// ==================== OTel Bridge Layer ====================

/**
 * 使用全局 TracerProvider 的 OTel 桥接层
 *
 * 前提：应用入口（instrument.ts）已通过 @opentelemetry/sdk-node 初始化。
 * Tracer.layerGlobal 将 Effect span 桥接到已注册的全局 provider。
 */
export const OtelTracerLayer = Layer.provide(Tracer.layerGlobal, Resource.layerFromEnv());

/**
 * 创建独立的 OTel 层（测试 / CLI / 独立进程）
 *
 * 不依赖外部 SDK 初始化，自带 TracerProvider + Resource。
 */
export const createStandaloneOtelLayer = (serviceName: string) =>
  NodeSdk.layer(() => ({
    resource: { serviceName },
  }));
