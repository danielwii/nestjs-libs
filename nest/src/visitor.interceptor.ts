import { GqlExecutionContext } from '@nestjs/graphql';

import { context, trace } from '@opentelemetry/api';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { VisitorRequest } from './interface';
import { Observable } from 'rxjs';

import type { Response } from 'express';

export class VisitorInterceptor implements NestInterceptor {
  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> | Promise<Observable<any>> {
    let req = ctx.switchToHttp().getRequest<VisitorRequest>();
    let res = ctx.switchToHttp().getResponse<Response>();
    if (!req) {
      req = GqlExecutionContext.create(ctx).getContext().req;
      res = GqlExecutionContext.create(ctx).getContext().res;
    }

    req.visitorId = req.headers['x-visitor-id'] as string;

    // ws subscription request
    if (!req || !res?.['getHeader']) {
      return next.handle();
    }

    const isSse = res.getHeader('Content-Type') === 'text/event-stream';
    if (!isSse && res.setHeader) {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan) res.setHeader('X-Trace-Id', currentSpan.spanContext().traceId);
    }

    return next.handle();
  }
}
