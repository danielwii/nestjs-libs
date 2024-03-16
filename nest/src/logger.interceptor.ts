import { context, trace } from '@opentelemetry/api';

import { CallHandler, ExecutionContext, Logger, NestInterceptor } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

import { f, METADATA_KEYS } from '@app/utils';

import type { Request, Response } from 'express';
import _ from 'lodash';
import { catchError, finalize, Observable } from 'rxjs';

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
    if (!req || req.url === '/') {
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
      headers: req.headers,
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
    const uid = 'uid' in req && req.uid ? `(${req.uid}) ` : '';
    const TAG = `${uid}#${ctx.getClass().name}.${ctx.getHandler().name || named}`;

    if (!res['getHeader']) {
      return next.handle();
    }

    const isSse = res.getHeader('Content-Type') === 'text/event-stream';
    if (res.setHeader && !isSse) {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan) res.setHeader('X-Trace-Id', currentSpan.spanContext().traceId);
    }

    this.logger.verbose(
      f`${TAG} call... (${req.ip}, ${req.ips}, ${req.hostname}) ${req.method} ${req.url} ${
        req.headers['user-agent']
      } ${['/', '/health'].includes(req.path) ? '' : info}`,
    );

    const now = Date.now();
    return next.handle().pipe(
      finalize(() => {
        this.logger.debug(f`${TAG} spent ${Date.now() - now}ms`);
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
