/**
 * HTTP tracing middleware —— 职责是**写 trace response header**（X-Trace-Id / traceparent）。
 *
 * 为什么放在 middleware 层：NestJS 执行顺序是 middleware → guard → interceptor → handler → filter。
 * 如果 guard 抛 UnauthorizedException，interceptor 不会执行，客户端拿到的错误响应就没
 * trace 信息，iOS / 日志排障都没法关联。middleware 在 guard 之前执行，这里写 header 能
 * 保证成功和异常两条路径都带上。
 *
 * 运行模式：
 * 1. **已有 active SERVER span**（Sentry 接管 OTel 时代，或 APP_OTEL_HTTP_INSTRUMENTATION_ENABLED
 *    开着）：读出来写 header，不再建重复的 span。
 * 2. **没有 active span**（默认——errors-only Sentry 的 httpIntegration `spans:false` 不建 span，
 *    HttpInstrumentation 又默认关）：自己建一个 SERVER span（让 GrpcInstrumentation 有 parent
 *    context 可传播），然后写 header。替代 @opentelemetry/instrumentation-http 的
 *    HttpInstrumentation —— 后者通过 context.bind(req/res) patch EventEmitter，在
 *    Apollo + Bun/JSC 下放大内存泄漏（https://github.com/open-telemetry/opentelemetry-js/issues/5514）。
 *    无论哪种配置组合，非健康检查响应必须带 X-Trace-Id/traceparent —— 这是本 middleware 的本职。
 *
 * 两种模式都**不**调用 context.bind(req/res)，不 patch EventEmitter。
 *
 * 自建 span 的名字：起名时只用 method，路由匹配后再改成 `{method} {路由模板}`（OTel semconv 的
 * `{method} {http.route}`）。原始 URL 不能进 span 名——路径段 / 查询串里可能有凭据（邀请 token 等），
 * 而 nest-logger 会把当前 span 名作为 `spanName` 写进请求内的每一行日志。
 */
import { matchedRouteTemplate, requestRouteForLog } from '../interceptors/log-redaction';

import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

import type { Span } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

const tracer = trace.getTracer('http-server');

// 本 middleware 自建的 SERVER span，按 req 记下，供路由匹配后改名。只登记自建的：Sentry / HttpInstrumentation
// 建的 span 归它们自己命名，这里不碰。WeakMap 随 req 回收，不需要手动清理。
const ownServerSpans = new WeakMap<object, Span>();

/**
 * 把本 middleware 为该请求自建的 SERVER span 改名为 `{method} {路由模板}`，并在匹配到路由时写 `http.route`。
 *
 * 调用时机：LoggerInterceptor 进入 handler 时（此时 Express 已匹配路由，之后 handler 内的日志 spanName 就带模板），
 * 以及响应 finish 时（覆盖 guard 拒绝、404 等 interceptor 没跑到的路径，决定导出的 span 名）。
 * 未匹配到路由时用去掉查询串的路径，规则与访问日志一致（见 requestRouteForLog）。
 * 不是自建 span（Sentry 模式读到已有 span、健康检查）时什么都不做。
 */
export function nameOwnServerSpanByRoute(req: Request): void {
  const span = ownServerSpans.get(req);
  if (!span) return;
  span.updateName(`${req.method} ${requestRouteForLog(req)}`);
  const template = matchedRouteTemplate(req);
  if (template !== undefined) span.setAttribute('http.route', template);
}

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

  // Sentry 模式：若 active context 里已有 SERVER span（Sentry 接管 OTel 或某个
  // instrumentation 建的），读取 + 写 header 即可。如果自己再建 span，会变成它的子
  // span —— traceId 相同但 response 里 spanId 会偏离 Sentry 看到的那个，给联调带来困扰。
  //
  // 但**没有** active span 时必须 fall through 到自建 span 分支：自 Sentry/OTel 分家
  // （instrument.ts `skipOpenTelemetrySetup: true` + `tracesSampleRate: 0`）起，Sentry 的
  // httpIntegration 自动 `spans: false`，永远不会建 HTTP SERVER span；HttpInstrumentation
  // 又是 opt-in（APP_OTEL_HTTP_INSTRUMENTATION_ENABLED）默认关。旧行为「读不到就不写」
  // 让所有配置了 SENTRY_DSN 的环境静默丢失 X-Trace-Id/traceparent（staging 实测断联半月，
  // iOS 排障找不到请求才暴露）。写 trace header 是本 middleware 的本职，不能依赖别人建 span。
  if (process.env.SENTRY_DSN) {
    const activeSpan = trace.getSpan(context.active());
    if (activeSpan) {
      const { traceId, spanId } = activeSpan.spanContext();
      writeTraceHeaders(res, traceId, spanId);
      next();
      return;
    }
    // fall through：errors-only Sentry 建不出 span，走下面的自建分支
  }

  // 自建 SERVER span（非 Sentry 模式，或 Sentry 模式下无人建 span）
  // 从请求头提取 propagation context（支持上游传入 traceparent）
  const parentCtx = propagation.extract(context.active(), req.headers);

  // 起名只用 method：此时还没路由匹配，原始 URL 可能带凭据，见文件头说明
  const span = tracer.startSpan(req.method, { kind: SpanKind.SERVER }, parentCtx);
  ownServerSpans.set(req, span);

  const spanCtx = trace.setSpan(parentCtx, span);
  const { traceId, spanId } = span.spanContext();

  // 在 next() 之前写 header，保证 guard 异常路径也能拿到 —— filter 渲染错误响应时 header 已就位
  writeTraceHeaders(res, traceId, spanId);

  // 在 span context 下执行后续 middleware/handler
  context.with(spanCtx, () => {
    res.on('finish', () => {
      nameOwnServerSpanByRoute(req);
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    next();
  });
}
