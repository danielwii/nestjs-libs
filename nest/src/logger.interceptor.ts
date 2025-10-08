import { CallHandler, ExecutionContext, Logger, NestInterceptor } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import _ from 'lodash';

import { catchError, finalize, Observable } from 'rxjs';
import { context, trace } from '@opentelemetry/api';
import { f, METADATA_KEYS } from '@app/utils';

import type { Request, Response } from 'express';

export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(this.constructor.name);

  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> | Promise<Observable<any>> {
    let req = ctx.switchToHttp().getRequest<Request>();
    let res = ctx.switchToHttp().getResponse<Response>();
    if (!req) {
      req = GqlExecutionContext.create(ctx).getContext().req;
      res = GqlExecutionContext.create(ctx).getContext().res;
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
    const uid = _.get(req, 'user.uid') as any as string;
    const TAG = `(${uid || 'anonymous'}) #${ctx.getClass().name}.${ctx.getHandler().name || named}`;

    // 健康检查路径，跳过日志记录
    const isHealthCheck = ['/', '/health'].includes(req.path);

    if (res && res.getHeader && res.setHeader) {
      const isSse = res.getHeader('Content-Type') === 'text/event-stream';
      if (!isSse) {
        const currentSpan = trace.getSpan(context.active());
        if (currentSpan) res.setHeader('X-Trace-Id', currentSpan.spanContext().traceId);
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
  }
}
