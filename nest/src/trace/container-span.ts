/**
 * Container Span - 解决 async 场景下 OTel span 层级丢失问题
 *
 * ## 问题背景
 *
 * OpenTelemetry 使用 context propagation 建立 span 父子关系。
 * 但在以下场景，context 会丢失：
 *
 * 1. **async 边界**：Promise.then/catch、setTimeout、EventEmitter
 * 2. **第三方库**：AI SDK 等库内部创建的 spans 不在同一 context 链
 * 3. **fire-and-forget**：异步任务与主流程脱离
 *
 * ## 解决方案：Container Span 模式
 *
 * 将"根 span"显式存储到 RequestContext（基于 AsyncLocalStorage），
 * 子 span 创建时主动查找 parent，而非依赖隐式 context propagation。
 *
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │  RequestContext (AsyncLocalStorage)                     │
 * │  ┌─────────────────────────────────────────────────┐   │
 * │  │ 'span.live.container'    → liveSpan             │   │
 * │  │ 'span.offline.container' → offlineSpan          │   │
 * │  └─────────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────┘
 *           ↑ set                    ↓ get
 *     setContainerSpan()      getContainerSpan()
 * ```
 *
 * ## 使用方式
 *
 * ```typescript
 * // 1. 创建根 span 并存储
 * const liveSpan = tracer.startSpan('live');
 * setContainerSpan('live', liveSpan);
 *
 * // 2. 用 otelContext.with() 包裹业务逻辑（关键！）
 * return otelContext.with(trace.setSpan(otelContext.active(), liveSpan), async () => {
 *   // 3. 子 span 通过 getParentSpan() 查找 parent
 *   const parent = getParentSpan('live');
 *   const childSpan = tracer.startSpan('child', {}, trace.setSpan(ROOT_CONTEXT, parent));
 * });
 * ```
 *
 * ## 设计原则
 *
 * 1. **显式优于隐式**：不依赖 OTel 的隐式 context propagation
 * 2. **key 任意**：不限制 container 命名，项目自定义（如 'live'、'offline'、'request'）
 * 3. **fallback 到 active**：找不到 container 时，降级使用 otelContext.active()
 * 4. **ROOT_CONTEXT 隔离**：避免 context 污染（如 live span 污染 offline 子 span）
 */
import { RequestContext } from './request-context';

import { context as otelContext, ROOT_CONTEXT, trace } from '@opentelemetry/api';

import type { Span } from '@opentelemetry/api';

/**
 * 生成 container span 的存储 key
 * 统一格式：`span.{containerKey}.container`
 */
function storageKey(containerKey: string): string {
  return `span.${containerKey}.container`;
}

/**
 * 存储 container span 到 RequestContext
 *
 * @param containerKey - 容器标识（如 'live'、'offline'、'request'）
 * @param span - 要存储的 span，传 undefined 则删除
 * @returns 之前存储的 span（如有）
 *
 * @example
 * ```typescript
 * const liveSpan = tracer.startSpan('live');
 * setContainerSpan('live', liveSpan);
 *
 * // 请求结束时清理
 * setContainerSpan('live', undefined);
 * ```
 */
export function setContainerSpan(containerKey: string, span: Span | undefined): Span | undefined {
  const key = storageKey(containerKey);
  const prev = RequestContext.get<Span>(key);
  RequestContext.set(key, span);
  return prev;
}

/**
 * 读取 container span
 *
 * @param containerKey - 容器标识
 * @returns 存储的 span，未找到返回 undefined
 */
export function getContainerSpan(containerKey: string): Span | undefined {
  return RequestContext.get<Span>(storageKey(containerKey));
}

/**
 * 查找 parent span
 *
 * 查找顺序：
 * 1. 指定的 container span（显式存储）
 * 2. 当前 active context 中的 span（OTel 隐式传递）
 *
 * @param containerKey - 优先查找的容器标识（可选）
 * @returns 找到的 parent span，未找到返回 undefined
 *
 * @example
 * ```typescript
 * // 优先从 'live' container 查找
 * const parent = getParentSpan('live');
 *
 * // 不指定 container，直接用 active context
 * const parent = getParentSpan();
 * ```
 */
export function getParentSpan(containerKey?: string): Span | undefined {
  // 1. 优先检查指定的 container
  if (containerKey) {
    const container = getContainerSpan(containerKey);
    if (container) return container;
  }

  // 2. Fallback 到 active context
  return trace.getSpan(otelContext.active());
}

/**
 * 解析 parent span 并构建隔离的 context
 *
 * 关键设计：使用 ROOT_CONTEXT 而非 otelContext.active()
 * - 避免 active context 中的其他 span 污染子 span 的 parent
 * - 例如：offline 任务不应该挂到 live span 下
 *
 * @param containerKey - 优先查找的容器标识（可选）
 * @returns { parentSpan, context } - parent span 和用于 startSpan 的 context
 *
 * @example
 * ```typescript
 * const { parentSpan, context } = resolveParentContext('live');
 * const childSpan = tracer.startSpan('child', {}, context);
 * // childSpan 的 parent 是 liveSpan（如果存在）
 * ```
 */
export function resolveParentContext(containerKey?: string): {
  parentSpan: Span | undefined;
  context: ReturnType<typeof otelContext.active>;
} {
  const parentSpan = getParentSpan(containerKey);

  return {
    parentSpan,
    // 有 container span 时，基于 ROOT_CONTEXT 构建干净的 context
    // 否则降级使用 active context（保持兼容）
    context: parentSpan ? trace.setSpan(ROOT_CONTEXT, parentSpan) : otelContext.active(),
  };
}
