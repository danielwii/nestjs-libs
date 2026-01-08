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
    // NestJS GraphQL 请求时 switchToHttp() 可能返回空对象
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时 req 可能为空
    if (!req) {
      req = GqlExecutionContext.create(ctx).getContext().req as VisitorRequest;
      res = GqlExecutionContext.create(ctx).getContext().res as Response;
    }

    req.visitorId = req.headers['x-visitor-id'] as string;

    // ws subscription request - res 在某些场景可能没有 getHeader 方法
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时 req/res 可能为空
    if (!req || !res?.getHeader) {
      return next.handle();
    }

    const isSse = res.getHeader('Content-Type') === 'text/event-stream';
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- setHeader 运行时可能不存在
    if (!isSse && res.setHeader) {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan) res.setHeader('X-Trace-Id', currentSpan.spanContext().traceId);
    }

    return next.handle();
  }
}
