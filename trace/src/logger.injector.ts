/* eslint-disable @typescript-eslint/unbound-method */
import { ConsoleLogger, Injectable } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import { RequestContext } from './request-context';
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

  private wrapPrototype<T extends (...args: unknown[]) => unknown>(prototype: T) {
    const originalMethod = prototype;
    return function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string') {
        args[0] = LoggerInjector.getMessage(args[0]);
      }
      return Reflect.apply(originalMethod, this, args);
    };
  }

  private static getMessage(message: string) {
    const currentSpan = trace.getSpan(context.active());
    const storeTraceId = RequestContext.get<string>('traceId');
    const storeUserId = RequestContext.get<string>('userId');

    if (!currentSpan) {
      if (storeTraceId) {
        return LoggerInjector.formatMessage(storeTraceId, storeUserId, message);
      }
      return message;
    }

    const spanContext = currentSpan.spanContext();
    const spanAttributes = (currentSpan as unknown as { attributes?: Record<string, unknown> }).attributes;
    const userIdFromSpan = spanAttributes?.['user.id'];
    const userId =
      typeof userIdFromSpan === 'string' && userIdFromSpan.trim().length > 0 ? userIdFromSpan : storeUserId;

    // 检查 span 是否已经结束，如果已结束则不再添加事件
    try {
      // 使用 span 的内部状态检查是否已结束
      const spanImpl = currentSpan as { isRecording?: () => boolean };
      if (spanImpl && typeof spanImpl.isRecording === 'function' && !spanImpl.isRecording()) {
        // Span 已结束，只记录 traceId，不添加事件
        const fallbackTraceId = spanContext.traceId || storeTraceId;
        if (!fallbackTraceId) {
          return message;
        }
        return LoggerInjector.formatMessage(fallbackTraceId, userId, message);
      }

      currentSpan.addEvent(message);
    } catch (error) {
      // 如果 span 已结束，只记录 traceId，不添加事件
      console.warn(`Cannot add event to ended span: ${error instanceof Error ? error.message : String(error)}`);
    }

    const traceId = spanContext.traceId || storeTraceId;
    if (!traceId) {
      return message;
    }
    return LoggerInjector.formatMessage(traceId, userId, message);
  }

  private static formatMessage(traceId: string, userId: unknown, message: string): string {
    if (typeof userId === 'string' && userId.trim().length > 0) {
      return `[${traceId}|${userId}] ${message}`;
    }
    return `[${traceId}] ${message}`;
  }
}
