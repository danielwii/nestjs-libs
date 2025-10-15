import { CallHandler, ExecutionContext, Logger, NestInterceptor } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import _ from 'lodash';

import { catchError, finalize, Observable } from 'rxjs';
import { context, trace } from '@opentelemetry/api';
import { f, METADATA_KEYS } from '@app/utils';
import { RequestContext } from '@app/trace';

import type { Request, Response } from 'express';

export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(this.constructor.name);

  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> | Promise<Observable<any>> {
    // 注意：Subscription 必须直接返回原始结果，任何额外的 pipe 都会把 AsyncIterator 变成 Observable，
    // 导致 graphql-transport-ws 收到 {} 而不是流式数据。
    let req = ctx.switchToHttp().getRequest<Request>();
    let res = ctx.switchToHttp().getResponse<Response>();

    const isGraphql = ctx.getType<'http' | 'graphql'>() === 'graphql';
    const gqlExecutionContext = isGraphql ? GqlExecutionContext.create(ctx) : null;
    const gqlOperation = gqlExecutionContext?.getInfo()?.operation?.operation ?? null;

    if (!req && gqlExecutionContext) {
      this.logger.log(
        f`-> #${ctx.getClass().name}.${ctx.getHandler().name} isGraphql=${isGraphql} gqlOperation=${gqlOperation}`,
      );
      const gqlContext = gqlExecutionContext.getContext<Record<string, any>>();
      req = gqlContext?.req;
      res = gqlContext?.res;
    }

    if (gqlOperation === 'subscription') {
      const gqlInfo = gqlExecutionContext?.getInfo();
      const handlerName = gqlInfo?.fieldName || ctx.getHandler().name || 'anonymous';
      const wsReq = (gqlExecutionContext?.getContext<Record<string, any>>()?.req ?? {}) as Request & {
        headers?: Record<string, unknown>;
      };

      this.logger.debug(
        f`-> (subscription) #${ctx.getClass().name}.${handlerName} headers=${maskWsHeaders(wsReq.headers)}`,
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

    // ws subscription request
    if (!req) {
      return next.handle();
    }

    const body = _.mapValues(req.body, (v) => (typeof v === 'string' && v.length > 100 ? `${v.slice(0, 100)}...` : v));
    const multiIpAddress = req.ip || req.ips || req.headers ? req.headers['x-forwarded-for'] : null;
    const ipAddress = _.isArray(multiIpAddress) ? multiIpAddress[0] : multiIpAddress;
    const info = {
      path: req.url,
      body,
      query: req.query,
      params: req.params,
      headers: {
        ...req.headers,
        cookie: req.headers['cookie'] ? `${req.headers['cookie'].slice(0, 100)}...` : req.headers['cookie'],
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
    const named = Reflect.getMetadata(METADATA_KEYS.NAMED, ctx.getHandler());
    const uid = typeof req.user === 'object' && req.user !== null && 'uid' in req.user
      ? (Reflect.get(req.user, 'uid') as string | undefined)
      : undefined;
    const TAG = `(${uid || 'anonymous'}) #${ctx.getClass().name}.${ctx.getHandler().name || named}`;

    // 健康检查路径，跳过日志记录
    const isHealthCheck = ['/', '/health'].includes(req.path);

    const currentSpan = trace.getSpan(context.active());
    const spanTraceId = currentSpan?.spanContext()?.traceId;
    const headerTraceId = typeof req.headers['x-trace-id'] === 'string' ? req.headers['x-trace-id'].trim() : undefined;
    const traceId = spanTraceId || headerTraceId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userIdFromRequest = typeof req.user === 'object' && req.user !== null && 'userId' in req.user
      ? (Reflect.get(req.user, 'userId') as string | undefined)
      : undefined;

    return RequestContext.run({ traceId, userId: userIdFromRequest ?? null }, () => {
      if (res && res.getHeader && res.setHeader && traceId) {
        const isSse = res.getHeader('Content-Type') === 'text/event-stream';
        if (!isSse) {
          res.setHeader('X-Trace-Id', traceId);
        }
      }

      if (!isHealthCheck) {
        this.logger.debug(
          f`-> ${TAG} call... (${req.ip}, ${req.ips}, ${req.hostname}) ${req.method} ${req.url} ${
            req.headers['user-agent']
          } ${info}`,
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
          const skipNotFound = _.get(e, 'status') !== 404;
          if (skipNotFound) {
            this.logger.warn(f`${TAG} ${info}: ${e}`);
          }
          throw e;
        }),
      );
    });
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
