import { GqlExecutionContext } from '@nestjs/graphql';

import { context, trace } from '@opentelemetry/api';

import type { VisitorRequest } from '@app/nest/common/interface';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

export class VisitorInterceptor implements NestInterceptor {
  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    // NestJS switchToHttp() 在 GraphQL 场景返回空对象，类型声明为可空
    // res 可能是不完整的对象（无 getHeader/setHeader），使用 Partial
    let req: VisitorRequest | undefined = ctx.switchToHttp().getRequest<VisitorRequest | undefined>();
    let res: Partial<Response> | undefined = ctx.switchToHttp().getResponse<Partial<Response> | undefined>();

    if (!req) {
      const gqlContext = GqlExecutionContext.create(ctx).getContext();
      req = gqlContext.req as VisitorRequest | undefined;
      res = gqlContext.res as Partial<Response> | undefined;
    }

    // ws subscription request - req/res 在某些场景可能不完整
    if (!req || !res?.getHeader) {
      return next.handle();
    }

    req.visitorId = req.headers['x-visitor-id'] as string;

    const isSse = res.getHeader('Content-Type') === 'text/event-stream';
    if (!isSse && res.setHeader) {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan) res.setHeader('X-Trace-Id', currentSpan.spanContext().traceId);
    }

    return next.handle();
  }
}
