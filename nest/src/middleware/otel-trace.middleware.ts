/**
 * 轻量 HTTP tracing middleware
 *
 * 替代 @opentelemetry/instrumentation-http 的 HttpInstrumentation。
 * HttpInstrumentation 通过 context.bind(req/res) patch EventEmitter 方法，
 * 在 Bun/JSC 下导致每个请求的闭包链无法被 GC，造成内存泄漏。
 * see: https://github.com/open-telemetry/opentelemetry-js/issues/5514
 *
 * 本 middleware 只做两件事：
 * 1. 用 context.with() 建立 OTel context（让下游代码能拿到 traceId）
 * 2. 创建一个 SERVER span（让 GrpcInstrumentation 有 parent context 可传播）
 *
 * 不调用 context.bind(req/res)，不 patch EventEmitter。
 */
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

import type { NextFunction, Request, Response } from 'express';

const tracer = trace.getTracer('http-server');

export function otelTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const url = req.url || '';

  // 健康检查不创建 span
  if (url === '/' || url.startsWith('/health')) {
    next();
    return;
  }

  // 从请求头提取 propagation context（支持上游传入 traceparent）
  const parentCtx = propagation.extract(context.active(), req.headers);

  const span = tracer.startSpan(`${req.method} ${url}`, { kind: SpanKind.SERVER }, parentCtx);

  const spanCtx = trace.setSpan(parentCtx, span);

  // 在 span context 下执行后续 middleware/handler
  // 注意：只用 context.with()，不用 context.bind(req/res)
  context.with(spanCtx, () => {
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    next();
  });
}
