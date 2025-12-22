import { GqlExecutionContext } from '@nestjs/graphql';

import { context, trace } from '@opentelemetry/api';

import type { VisitorRequest } from '@app/nest/common/interface';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

export class VisitorInterceptor implements NestInterceptor {
  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    let req = ctx.switchToHttp().getRequest<VisitorRequest>();
    let res = ctx.switchToHttp().getResponse<Response>();
    if (!req) {
      req = GqlExecutionContext.create(ctx).getContext().req;
      res = GqlExecutionContext.create(ctx).getContext().res;
    }

    req.visitorId = req.headers['x-visitor-id'] as string;

    // ws subscription request
    if (!req || !res?.getHeader) {
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
