/**
 * HTTP tracing middleware —— 职责是**写 trace response header**（X-Trace-Id / traceparent）。
 *
 * 为什么放在 middleware 层：NestJS 执行顺序是 middleware → guard → interceptor → handler → filter。
 * 如果 guard 抛 UnauthorizedException，interceptor 不会执行，客户端拿到的错误响应就没
 * trace 信息，iOS / 日志排障都没法关联。middleware 在 guard 之前执行，这里写 header 能
 * 保证成功和异常两条路径都带上。
 *
 * 两种运行模式：
 * 1. **Sentry 模式**（`SENTRY_DSN` 已配置）：Sentry 通过 `instrument.js` 预加载已经挂了
 *    HttpInstrumentation，active context 里已经有 SERVER span。我们只需要读出来写 header，
 *    不再建重复的 span。
 * 2. **非 Sentry 模式**：我们自己建一个 SERVER span（让 GrpcInstrumentation 有 parent
 *    context 可传播），然后写 header。替代 @opentelemetry/instrumentation-http 的
 *    HttpInstrumentation —— 后者通过 context.bind(req/res) patch EventEmitter，在
 *    Apollo + Bun/JSC 下放大内存泄漏（https://github.com/open-telemetry/opentelemetry-js/issues/5514）。
 *
 * 两种模式都**不**调用 context.bind(req/res)，不 patch EventEmitter。
 */
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

import type { NextFunction, Request, Response } from 'express';

const tracer = trace.getTracer('http-server');

function writeTraceHeaders(res: Response, traceId: string, spanId: string): void {
  // W3C Trace Context 标准格式: 00-{traceId}-{spanId}-{flags}，flags: 01 表示已采样
  res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);
  res.setHeader('X-Trace-Id', traceId);
}

export function otelTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const url = req.url || '';

  // 健康检查不建 span 也不写 trace header（K8s probe 不需要）
  if (url === '/' || url.startsWith('/health')) {
    next();
    return;
  }

  // Sentry 模式：Sentry 的 HttpInstrumentation 已在 request 进入时创建了 SERVER span，
  // 本 middleware 跑到这一刻 active context 里就有 Sentry 的 span。我们只需读取 + 写 header。
  // 如果自己再建 span，会变成 Sentry span 的子 span —— traceId 相同但 response 里 spanId
  // 会偏离 Sentry 看到的那个，给联调带来困扰。
  if (process.env.SENTRY_DSN) {
    const activeSpan = trace.getSpan(context.active());
    if (activeSpan) {
      const { traceId, spanId } = activeSpan.spanContext();
      writeTraceHeaders(res, traceId, spanId);
    }
    next();
    return;
  }

  // 非 Sentry 模式：自建 SERVER span
  // 从请求头提取 propagation context（支持上游传入 traceparent）
  const parentCtx = propagation.extract(context.active(), req.headers);

  const span = tracer.startSpan(`${req.method} ${url}`, { kind: SpanKind.SERVER }, parentCtx);

  const spanCtx = trace.setSpan(parentCtx, span);
  const { traceId, spanId } = span.spanContext();

  // 在 next() 之前写 header，保证 guard 异常路径也能拿到 —— filter 渲染错误响应时 header 已就位
  writeTraceHeaders(res, traceId, spanId);

  // 在 span context 下执行后续 middleware/handler
  context.with(spanCtx, () => {
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    next();
  });
}
