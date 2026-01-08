import { Logger } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { RequestContext } from '@app/nest/trace/request-context';
import { METADATA_KEYS } from '@app/utils/annotation';
import { f } from '@app/utils/logging';

import { context, trace } from '@opentelemetry/api';
import * as _ from 'radash';
import { catchError, finalize } from 'rxjs';

import type { IdentityRequest } from '../types/identity.interface';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(this.constructor.name);

  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    // 注意：Subscription 必须直接返回原始结果，任何额外的 pipe 都会把 AsyncIterator 变成 Observable，
    // 导致 graphql-transport-ws 收到 {} 而不是流式数据。
    let req = ctx.switchToHttp().getRequest<IdentityRequest>();
    let res = ctx.switchToHttp().getResponse<Response>();

    const isGraphql = ctx.getType<'http' | 'graphql'>() === 'graphql';
    const gqlExecutionContext = isGraphql ? GqlExecutionContext.create(ctx) : null;
    const gqlOperation = gqlExecutionContext?.getInfo()?.operation?.operation ?? null;

    // NestJS GraphQL 请求时 switchToHttp().getRequest() 返回空对象，需要从 GqlContext 获取
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时 req 可能为空对象
    if (!req && gqlExecutionContext) {
      const gqlContext = gqlExecutionContext.getContext<Record<string, unknown>>();
      req = gqlContext.req as IdentityRequest;
      res = gqlContext.res as Response;
      // req 可能来自 GraphQL context，headers 结构可能与标准 Express 不同
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GraphQL context 的 req.headers 运行时可能为 undefined
      const ua = req.headers?.['user-agent'];
      this.logger.log(
        f`-> #${ctx.getClass().name}.${ctx.getHandler().name} isGraphql=${isGraphql} gqlOperation=${gqlOperation} ua=${ua}`,
      );
    }

    if (gqlOperation === 'subscription' && gqlExecutionContext) {
      const gqlInfo = gqlExecutionContext.getInfo();
      const handlerName = gqlInfo?.fieldName ?? ctx.getHandler().name ?? 'anonymous';
      const wsReq = (gqlExecutionContext.getContext<Record<string, unknown>>().req ?? {}) as Request & {
        headers?: Record<string, unknown>;
      };
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- WebSocket request headers 运行时可能为 undefined
      const wsUa = wsReq.headers?.['user-agent'];
      this.logger.debug(
        f`-> (subscription) #${ctx.getClass().name}.${handlerName} ua=${wsUa} headers=${maskWsHeaders(wsReq.headers)}`,
      );
      const result = next.handle();
      const rawResult: unknown = result;
      let constructorName = typeof rawResult;
      let hasAsyncIterator = false;
      let hasSubscribe = false;

      if (typeof rawResult === 'object' && rawResult !== null) {
        const ctor = Reflect.get(rawResult, 'constructor');
        if (ctor && typeof ctor === 'function' && typeof ctor.name === 'string') {
          constructorName = ctor.name;
        }
        hasAsyncIterator = typeof Reflect.get(rawResult, Symbol.asyncIterator) === 'function';
        hasSubscribe = typeof Reflect.get(rawResult, 'subscribe') === 'function';
      }

      this.logger.debug(
        f`<- (subscription) #${ctx.getClass().name}.${handlerName} resultType=${typeof result} constructor=${constructorName} hasAsyncIterator=${hasAsyncIterator} hasSubscribe=${hasSubscribe}`,
      );
      return result;
    }

    // gRPC request handling
    if (ctx.getType() === 'rpc') {
      return this.handleRpcRequest(ctx, next);
    }

    // ws subscription request - NestJS 某些场景下 req 可能为空
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时 req 可能为空
    if (!req) {
      this.logger.warn(
        f`Request object is empty, skipping logging for ${ctx.getClass().name}.${ctx.getHandler().name}`,
      );
      return next.handle();
    }

    const body = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > 100 ? `${v.slice(0, 100)}...` : v,
      ]),
    );
    // 获取客户端 IP：优先使用 req.ip，其次 req.ips[0]，最后 x-forwarded-for
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Express req.ips 运行时可能为 undefined
    const multiIpAddress = req.ip ?? req.ips?.[0] ?? req.headers['x-forwarded-for'];
    const ipAddress = Array.isArray(multiIpAddress) ? multiIpAddress[0] : multiIpAddress;
    const info = {
      path: req.url,
      body,
      query: req.query,
      params: req.params,
      headers: {
        ...req.headers,
        cookie: req.headers.cookie ? `${req.headers.cookie.slice(0, 100)}...` : req.headers.cookie,
      },
      /*
            raw: req.raw,
            id: req.id,
            */
      ip: ipAddress !== '::1' ? ipAddress?.replace(/:\d+$/, '') : ipAddress,
      // parsedIp: ip.toBuffer(req.ip).toString('utf8'),
      ips: req.ips,
      hostname: req.hostname,
      // isMobile: req.isMobile,
      // sessionID: req.sessionID,
      // signedCookies: req.signedCookies,
      // session: req.session,
    };

    // !!TIPS!! @metinseylan/nestjs-opentelemetry make handler name null
    const named = Reflect.getMetadata(METADATA_KEYS.NAMED, ctx.getHandler()) as string | undefined;
    const uid = req.user?.uid;
    // handler.name 在 OpenTelemetry 插件下可能为空字符串或被覆盖

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR：name 为空字符串时也应 fallback
    const TAG = `(${uid ?? 'anonymous'}) #${ctx.getClass().name}.${ctx.getHandler().name || named || 'anonymous'}`;

    // 健康检查路径，跳过日志记录
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GraphQL 场景 req.path 运行时可能为 undefined
    const isHealthCheck = req.path?.startsWith('/health') || req.path === '/';

    const currentSpan = trace.getSpan(context.active());
    const spanTraceId = currentSpan?.spanContext().traceId;
    const headerTraceId = typeof req.headers['x-trace-id'] === 'string' ? req.headers['x-trace-id'].trim() : undefined;
    const traceId = spanTraceId ?? headerTraceId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userIdFromRequest = req.user?.userId;

    // 获取 spanId 用于构建 traceparent
    const spanId = currentSpan?.spanContext().spanId ?? crypto.randomUUID().replace(/-/g, '').substring(0, 16);

    return RequestContext.run({ traceId, userId: userIdFromRequest ?? null }, () => {
      // res 在 GraphQL 场景下可能为 undefined，traceId 总是存在
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- res 运行时可能为 undefined
      if (res?.getHeader && res.setHeader) {
        const isSse = res.getHeader('Content-Type') === 'text/event-stream';
        if (!isSse) {
          // W3C Trace Context 标准格式: 00-{traceId}-{spanId}-{flags}
          // flags: 01 表示已采样
          res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);
          // 保留 X-Trace-Id 向后兼容
          res.setHeader('X-Trace-Id', traceId);
        }
      }

      if (!isHealthCheck) {
        this.logger.debug(
          f`-> ${TAG} call... ip=${ipAddress} ${req.method} ${req.url} ua=${req.headers['user-agent']}`,
        );
      }

      const now = Date.now();
      return next.handle().pipe(
        finalize(() => {
          if (!isHealthCheck) {
            this.logger.debug(f`<- ${TAG} spent ${Date.now() - now}ms`);
          }
        }),
        catchError((e) => {
          const skipNotFound = (e as { status?: number }).status !== 404;
          if (skipNotFound) {
            this.logger.warn(f`${TAG} ${info}: ${e}`);
          }
          throw e;
        }),
      );
    });
  }

  /**
   * Handle gRPC/RPC requests with logging and tracing
   *
   * gRPC trace propagation via metadata:
   * - Client sends `traceparent` header in gRPC metadata
   * - Format: "00-{traceId}-{spanId}-{flags}" (W3C Trace Context)
   * - We extract traceId from metadata or OpenTelemetry span
   *
   * 日志格式与 HTTP 保持一致：
   * -> (rpc) #Class.method call... data={...}
   * <- (rpc) #Class.method spent Xms
   */
  private handleRpcRequest(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const rpcCtx = ctx.switchToRpc();
    const data = rpcCtx.getData();
    const rpcContext = rpcCtx.getContext();

    const className = ctx.getClass().name;
    const handlerName = ctx.getHandler().name;
    const TAG = `(rpc) #${className}.${handlerName}`;

    // Extract traceId from gRPC metadata or OpenTelemetry span
    const traceId = this.extractGrpcTraceId(rpcContext);

    return RequestContext.run({ traceId, userId: null }, () => {
      // Truncate large data for logging (similar to HTTP body truncation)
      const truncatedData = this.truncateData(data);
      this.logger.debug(f`-> ${TAG} call... data=${truncatedData}`);

      const now = Date.now();
      return next.handle().pipe(
        finalize(() => {
          this.logger.debug(f`<- ${TAG} spent ${Date.now() - now}ms`);
        }),
        catchError((e) => {
          this.logger.error(f`${TAG} error: ${e}`);
          throw e;
        }),
      );
    });
  }

  /**
   * Extract traceId from gRPC metadata or OpenTelemetry span
   *
   * Priority:
   * 1. OpenTelemetry active span (if gRPC instrumentation enabled)
   * 2. gRPC metadata `traceparent` header (W3C format: 00-{traceId}-{spanId}-{flags})
   * 3. gRPC metadata `x-trace-id` header (custom header)
   * 4. Generate new traceId
   */
  private extractGrpcTraceId(rpcContext: unknown): string {
    // 1. Try OpenTelemetry span first (requires @opentelemetry/instrumentation-grpc)
    const currentSpan = trace.getSpan(context.active());
    const spanTraceId = currentSpan?.spanContext().traceId;
    if (spanTraceId) {
      return spanTraceId;
    }

    // 2. Try gRPC metadata (fallback if no OpenTelemetry instrumentation)
    // NestJS gRPC context is a @grpc/grpc-js Metadata object
    const metadata = rpcContext as { get?: (key: string) => string[] } | undefined;
    if (metadata?.get) {
      // Try W3C traceparent format: "00-{traceId}-{spanId}-{flags}"
      const traceparent = metadata.get('traceparent')[0];
      if (traceparent) {
        const parts = traceparent.split('-');
        if (parts.length >= 2 && parts[1]?.length === 32) {
          return parts[1];
        }
      }

      // Try custom x-trace-id header
      const xTraceId = metadata.get('x-trace-id')[0];
      if (xTraceId) {
        return xTraceId.trim();
      }
    }

    // 3. Generate new traceId
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Truncate large data objects for logging
   */
  private truncateData(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      return data.length > 200 ? `${data.slice(0, 200)}...` : data;
    }

    if (typeof data !== 'object') {
      return data;
    }

    // For objects, create a truncated copy
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 100) {
        result[key] = `${value.slice(0, 100)}...`;
      } else if (Array.isArray(value) && value.length > 5) {
        result[key] = `[Array(${value.length})]`;
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

const SENSITIVE_WS_HEADER_PATTERN = /authorization|token|cookie|secret/i;

function maskWsHeaders(headers?: Record<string, unknown>) {
  if (!headers) {
    return {};
  }

  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_WS_HEADER_PATTERN.test(key) && typeof value === 'string') {
      masked[key] = value.length > 12 ? `${value.slice(0, 12)}...` : value;
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
