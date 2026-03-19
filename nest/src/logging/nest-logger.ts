import { getAppLogger } from '@app/utils/app-logger';
import { RequestContext } from '@app/nest/trace/request-context';
import { onelineStack } from '@app/utils/error';

import { lazy } from '@logtape/logtape';

import type { Logger } from '@logtape/logtape';
import { context, trace } from '@opentelemetry/api';

import type { LoggerService } from '@nestjs/common';

/**
 * NestJS LoggerService backed by LogTape.
 *
 * Replaces the built-in ConsoleLogger so that every `new Logger()` in the
 * codebase automatically delegates here. Context (traceId, userId, spanName)
 * is injected via `lazy()` — no monkey-patching required.
 *
 * 上下文来源优先级：
 * - OTel span（instrument.js preload 注册 TracerProvider，dev/prod 均有效）
 * - RequestContext 回退（CLI 命令、测试等无 preload 场景，
 *   或 LoggerInterceptor 从 req.user 写入的 userId）
 *
 * 正常请求链路中两者 traceId 一致（LoggerInterceptor 优先从 span 取值再写入 RequestContext）。
 */
export class LogtapeNestLogger implements LoggerService {
  private readonly baseLogger = getAppLogger().with({
    // OTel span 优先；无 span 时回退到 RequestContext（测试/CLI 等无 preload 场景）
    traceId: lazy(() => {
      const span = trace.getSpan(context.active());
      if (span) return span.spanContext().traceId;
      return RequestContext.get<string>('traceId');
    }),
    // span attribute 'user.id' 优先；回退到 RequestContext（LoggerInterceptor 从 req.user 写入）
    userId: lazy(() => {
      const span = trace.getSpan(context.active());
      if (span) {
        const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
        const uid = attrs?.['user.id'];
        if (typeof uid === 'string' && uid.trim().length > 0) return uid;
      }
      return RequestContext.get<string>('userId');
    }),
    // 仅从 OTel span 读取，无回退
    spanName: lazy(() => {
      const span = trace.getSpan(context.active());
      if (!span) return undefined;
      return (span as unknown as { name?: string }).name;
    }),
    // RequestContext 中除已知字段外的额外 string 值，自动追加到日志 context tag
    contextTags: lazy(() => {
      const entries = RequestContext.entries();
      if (!entries) return undefined;
      const KNOWN_KEYS = new Set(['traceId', 'userId', 'spanName']);
      const tags: string[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (!KNOWN_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
          tags.push(value);
        }
      }
      return tags.length > 0 ? tags : undefined;
    }),
  });

  // LogTape gotcha: logger.info(string) 会把 {...} 当消息模板占位符，导致内容丢失显示 undefined。
  // 必须使用 tagged template: logger.info`${msg}`
  // 配合 configure.ts 的 value: String 避免插值被 inspect 加引号。

  log(message: unknown, ...optionalParams: unknown[]): void {
    const [msg, logger] = this.extractContext(message, optionalParams);
    logger.info`${msg}`;
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    const [msg, logger] = this.extractContextWithStack(message, optionalParams);
    logger.error`${msg}`;
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const [msg, logger] = this.extractContextWithStack(message, optionalParams);
    logger.warning`${msg}`;
  }

  debug?(message: unknown, ...optionalParams: unknown[]): void {
    const [msg, logger] = this.extractContext(message, optionalParams);
    logger.debug`${msg}`;
  }

  verbose?(message: unknown, ...optionalParams: unknown[]): void {
    const [msg, logger] = this.extractContext(message, optionalParams);
    logger.debug`${msg}`;
  }

  fatal?(message: unknown, ...optionalParams: unknown[]): void {
    const [msg, logger] = this.extractContext(message, optionalParams);
    logger.fatal`${msg}`;
  }
   

  /**
   * Extract trailing context string (NestJS convention: last arg is the class/module name).
   * Returns [message, childLogger].
   */
  private extractContext(message: unknown, params: unknown[]): [unknown, Logger] {
    const ctx = params.length > 0 && typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const logger = ctx ? this.baseLogger.getChild(ctx) : this.baseLogger;
    return [message, logger];
  }

  /**
   * Handle NestJS error/warn 3-arg pattern: (message, stack, context).
   * Merges stack into message via onelineStack.
   */
  private extractContextWithStack(message: unknown, params: unknown[]): [unknown, Logger] {
    // NestJS pattern: error(message, stack, context)
    if (params.length >= 2 && typeof params[0] === 'string' && typeof params[1] === 'string') {
      const stack = params[0];
      const ctx = params[1];
      const logger = this.baseLogger.getChild(ctx);
      return [`${String(message)} ${onelineStack(stack)}`, logger];
    }

    // NestJS pattern: error(message, stack) — stack without context
    if (params.length === 1 && typeof params[0] === 'string') {
      // Could be either a context string or a stack trace
      const param = params[0];
      if (param.includes('\n') || param.startsWith('Error:') || param.includes('    at ')) {
        return [`${String(message)} ${onelineStack(param)}`, this.baseLogger];
      }
      // It's a context string
      const logger = this.baseLogger.getChild(param);
      return [message, logger];
    }

    // NestJS ExceptionsZone: error(errorObject) — single Error arg, no context
    if (message instanceof Error) {
      return [`${message.message} ${onelineStack(message.stack)}`, this.baseLogger];
    }

    return [message, this.baseLogger];
  }
}
