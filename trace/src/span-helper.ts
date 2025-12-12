import { context, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

export interface SpanInputOutputOptions {
  name: string;
  metadata?: Record<string, any>;
  parentSpan?: any;
  startTime?: Date;
}

/**
 * 创建一个带有 input 和 output 的 OTel span
 * 这个函数会自动将 input 和 output 转换为 Langfuse 可以识别的格式
 */
function createSpan(options: SpanInputOutputOptions) {
  const { name, metadata = {}, parentSpan, startTime } = options;

  const tracer = trace.getTracer('ai');

  // 创建 span 上下文
  let spanContext = context.active();
  if (parentSpan) {
    spanContext = trace.setSpan(context.active(), parentSpan);
  }

  // 创建 span
  const span = tracer.startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      startTime: startTime,
    },
    spanContext,
  );

  // 设置基础属性
  const attributes: Record<string, any> = {
    ...metadata,
  };

  // 设置所有属性
  span.setAttributes(attributes);

  return span;
}

export class LangfuseToolCallSpan {
  private readonly span: Span;
  constructor(
    public readonly toolName: string,
    public readonly toolCallId: string,
  ) {
    this.span = createSpan({
      name: `ai.toolCall ${toolName}`,
      metadata: {
        'ai.toolCall.id': toolCallId,
      },
    });
  }

  setResult(input: any, output: any, metadata: Record<string, any>) {
    this.span.setAttributes({
      'ai.toolCall.args': typeof input === 'string' ? input : JSON.stringify(input),
      'ai.toolCall.result': typeof output === 'string' ? output : JSON.stringify(output),
      ...metadata,
    });
  }

  end(endTime?: Date) {
    this.span.setStatus({ code: SpanStatusCode.OK });
    this.span.end(endTime);
  }
}
