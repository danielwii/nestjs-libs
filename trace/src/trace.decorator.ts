import { context, Span, SpanKind, trace } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api/build/src/trace/status';

/**
 * 放在方法上，自动创建一个 span，需要放在最下方
 * @param spanName
 * @constructor
 */
export const Trace =
  (spanName?: string): MethodDecorator =>
  (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const tracer = trace.getTracer('default');
      const actualSpanName = spanName || propertyKey;
      const span: Span = tracer.startSpan(actualSpanName, {
        kind: SpanKind.INTERNAL,
      });

      try {
        return await context.with(
          trace.setSpan(context.active(), span),
          async () => await originalMethod.apply(this, args),
        );
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        throw error;
      } finally {
        span.end();
      }
    };

    return descriptor;
  };
