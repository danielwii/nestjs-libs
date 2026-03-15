/**
 * Effect Trace 模块
 *
 * 目前只导出 Langfuse 契约（OTel span attribute 映射，框架无关）。
 *
 * NestJS 侧的 @Trace、RequestContext、ContainerSpan 等机制
 * 在 Effect 中不需要独立实现，原因：
 *
 * - @Trace 装饰器 → Effect.withSpan('name')
 *   Effect 原生 span 支持，自动管理生命周期和错误状态
 *
 * - RequestContext (AsyncLocalStorage) → FiberRef
 *   Effect 的 Fiber 天然携带上下文，每个请求是独立的 Fiber 树，
 *   不需要手动管理 AsyncLocalStorage，跨异步边界自动传播
 *
 * - ContainerSpan / StageScope → Fiber 树自动传播
 *   父 span 通过 Fiber 树自然传递，不需要手动 context.with()
 *   或存到 RequestContext 里
 *
 * - OTel Propagation → @effect/platform HttpServer 已内置
 *   HTTP 入口的 trace context 提取由框架完成
 */
export * from './langfuse/index';
