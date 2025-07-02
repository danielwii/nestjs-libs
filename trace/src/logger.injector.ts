import { ConsoleLogger, Injectable } from '@nestjs/common';

import { context, trace } from '@opentelemetry/api';
import { Injector } from './injector';

@Injectable()
export class LoggerInjector implements Injector {
  public inject() {
    ConsoleLogger.prototype.log = this.wrapPrototype(ConsoleLogger.prototype.log);
    ConsoleLogger.prototype.debug = this.wrapPrototype(ConsoleLogger.prototype.debug);
    ConsoleLogger.prototype.error = this.wrapPrototype(ConsoleLogger.prototype.error);
    ConsoleLogger.prototype.verbose = this.wrapPrototype(ConsoleLogger.prototype.verbose);
    ConsoleLogger.prototype.warn = this.wrapPrototype(ConsoleLogger.prototype.warn);
  }

  private wrapPrototype(prototype: any) {
    const originalMethod = prototype;
    return function (this: any, ...args: any[]) {
      args[0] = LoggerInjector.getMessage(args[0]);
      return originalMethod.apply(this, args);
    };
  }

  private static getMessage(message: string) {
    const currentSpan = trace.getSpan(context.active());
    if (!currentSpan) return message;

    const spanContext = currentSpan.spanContext();

    // 检查 span 是否已经结束，如果已结束则不再添加事件
    try {
      // 使用 span 的内部状态检查是否已结束
      const spanImpl = currentSpan as any;
      if (spanImpl && typeof spanImpl.isRecording === 'function' && !spanImpl.isRecording()) {
        // Span 已结束，只记录 traceId，不添加事件
        return `[${spanContext.traceId}] ${message}`;
      }

      currentSpan.addEvent(message);
    } catch (error) {
      // 如果 span 已结束，只记录 traceId，不添加事件
      console.warn(`Cannot add event to ended span: ${error instanceof Error ? error.message : String(error)}`);
    }

    return `[${spanContext.traceId}] ${message}`;
  }
}
