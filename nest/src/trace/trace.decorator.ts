import { describeError } from '@app/utils/describe-error';

import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import type { Span } from '@opentelemetry/api';

/**
 * 放在方法上，自动创建一个 span，需要放在最下方
 * @param spanName
 * @constructor
 */
export const Trace =
  (spanName?: string): MethodDecorator =>
  (_target: unknown, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const tracer = trace.getTracer('default');
      const actualSpanName = spanName ?? propertyKey.toString();
      const span: Span = tracer.startSpan(actualSpanName, {
        kind: SpanKind.INTERNAL,
      });

      try {
        return await context.with(
          trace.setSpan(context.active(), span),
          async () => await originalMethod.apply(this, args),
        );
      } catch (e: unknown) {
        // 状态消息只写 describeError 的内容，不写 message。
        span.setStatus({ code: SpanStatusCode.ERROR, message: describeError(e) });
        throw e;
      } finally {
        span.end();
      }
    };

    return descriptor;
  };
