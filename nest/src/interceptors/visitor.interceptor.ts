import { GqlExecutionContext } from '@nestjs/graphql';

import type { VisitorRequest } from '@app/nest/common/interface';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

export class VisitorInterceptor implements NestInterceptor {
  public intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> | Promise<Observable<unknown>> {
    // NestJS switchToHttp() 在 GraphQL 场景可能返回空对象或 undefined
    let req: VisitorRequest | undefined = ctx.switchToHttp().getRequest<VisitorRequest | undefined>();

    if (!req) {
      const gqlContext = GqlExecutionContext.create(ctx).getContext();
      req = gqlContext.req as VisitorRequest | undefined;
    }

    // GraphQL subscription / ws 场景下 req 可能是 truthy 但缺字段（例如没有 headers），
    // 直接访问 req.headers['x-visitor-id'] 会抛 TypeError。没有 headers 就不提取 visitorId。
    if (!req?.headers) {
      return next.handle();
    }

    req.visitorId = req.headers['x-visitor-id'] as string;

    return next.handle();
  }
}
