import { context, SpanKind, trace } from '@opentelemetry/api';

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
      const actualSpanName = spanName || propertyKey.toString();
      const span: Span = tracer.startSpan(actualSpanName, {
        kind: SpanKind.INTERNAL,
      });

      try {
        return await context.with(
          trace.setSpan(context.active(), span),
          async () => await originalMethod.apply(this, args),
        );
      } catch (e: unknown) {
        span.setStatus({
          code: 2,
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      } finally {
        span.end();
      }
    };

    return descriptor;
  };
