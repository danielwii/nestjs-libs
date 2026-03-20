/**
 * LogTape-backed Effect Logger
 *
 * Effect.log → LogTape → 统一格式：
 * - dev:  `2026-03-16 15:00:00.022+09:00 INFO [spanName|traceId|userId] unee-mcp·Prisma: message`
 * - prod: JSON lines
 *
 * 日志级别统一使用 LogTape 命名（TRACE/DEBUG/INFO/WARNING/ERROR/FATAL），
 * 兼容 NestJS 旧名（verbose/log/warn）。
 */

import { devFormatter, prodFormatter } from '@app/utils/log-formatter';
import { r } from '@app/utils/logging';

import { getAppLogger } from './app-logger';

import { configure, getConsoleSink } from '@logtape/logtape';
import { context, trace } from '@opentelemetry/api';
import { Cause, Effect, Layer, Logger, LogLevel } from 'effect';

// ==================== Effect Logger → LogTape Bridge ====================

const logtapeLogger = Logger.make(({ logLevel, message, cause, annotations, spans }) => {
  const props: Record<string, unknown> = {};

  // Effect annotations → LogTape properties
  for (const [k, v] of annotations as Iterable<[string, unknown]>) {
    props[k] = v;
  }

  // Effect log spans (from Effect.withLogSpan) → spanName
  for (const span of spans as Iterable<{ label: string }>) {
    props['spanName'] = span.label;
    break;
  }

  // OTel context fallback
  if (!props['traceId'] || !props['spanName'] || !props['userId']) {
    const span = trace.getSpan(context.active());
    if (span) {
      props['traceId'] ??= span.spanContext().traceId;
      // as unknown: OTel Span 接口不暴露 name/attributes，但运行时存在。
      // 这是 @opentelemetry/api 的已知限制，无公开 API 获取这些字段。
      props['spanName'] ??= (span as unknown as { name?: string }).name;
      if (!props['userId']) {
        const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
        const uid = attrs?.['user.id'];
        if (typeof uid === 'string' && uid.trim().length > 0) props['userId'] = uid;
      }
    }
  }

  // Route to LogTape logger with module as child category
  const category = (props['module'] ?? props['service']) as string | undefined;
  const baseLogger = getAppLogger();
  const logger = category ? baseLogger.getChild(category).with(props) : baseLogger.with(props);

  // Render message: non-string values go through r() for inspect coloring
  const parts = Array.isArray(message) ? message : [message];
  let msg = parts.map((p) => (typeof p === 'string' ? p : r(p))).join(' ');

  // Append cause if present (Effect Cause contains the actual error on fiber failure)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cause can be Empty at runtime despite the type
  const hasCause = cause && '_tag' in cause && (cause as { _tag: string })._tag !== 'Empty';
  if (hasCause) {
    const causeStr = Cause.pretty(cause);
    msg = msg ? `${msg}\n${causeStr}` : causeStr;
  }

  // Effect LogLevel → LogTape method
  // Unhandled fiber errors arrive as DEBUG from runMain — escalate to FATAL
  const effectiveLevel = hasCause && LogLevel.lessThan(logLevel, LogLevel.Error) ? LogLevel.Fatal : logLevel;

  if (LogLevel.greaterThanEqual(effectiveLevel, LogLevel.Fatal)) {
    logger.fatal`${msg}`;
  } else if (LogLevel.greaterThanEqual(effectiveLevel, LogLevel.Error)) {
    logger.error`${msg}`;
  } else if (LogLevel.greaterThanEqual(effectiveLevel, LogLevel.Warning)) {
    logger.warning`${msg}`;
  } else if (LogLevel.greaterThanEqual(effectiveLevel, LogLevel.Info)) {
    logger.info`${msg}`;
  } else if (LogLevel.greaterThanEqual(effectiveLevel, LogLevel.Debug)) {
    logger.debug`${msg}`;
  } else {
    logger.trace`${msg}`;
  }
});

// ==================== LogTape Configuration ====================

/** NestJS 旧名 → LogTape 标准名 */
const nestAliases: Record<string, string> = { verbose: 'trace', log: 'info', warn: 'warning' };
const normalizeLogLevel = (level: string): string => nestAliases[level] ?? level;

const ensureLogTapeConfigured = (() => {
  let configured = false;
  return async () => {
    if (configured) return;
    configured = true;

    // why: ensureLogTapeConfigured 是同步闭包，Logger 初始化在 Config Layer 之前
    const isProd = process.env.NODE_ENV === 'production';
    const lowestLevel = normalizeLogLevel(process.env.LOG_LEVEL ?? 'debug');

    await configure({
      reset: true, // override instrument.ts preload configure if already called
      sinks: {
        console: getConsoleSink({
          formatter: isProd ? prodFormatter : devFormatter,
        }),
      },
      loggers: [
        { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
        {
          category: [],
          sinks: ['console'],
          lowestLevel: lowestLevel as 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal',
        },
      ],
    });
  };
})();

// ==================== Layer ====================

/**
 * LogTape-backed Effect Logger
 *
 * - Effect Logger 全放行（不过滤），所有日志到 LogTape
 * - 日志级别由 LogTape 统一控制（LOG_LEVEL env var）
 * - 级别名以 LogTape 为标准：trace/debug/info/warning/error/fatal
 */
export const LogTapeLoggerLayer: Layer.Layer<never> = Layer.unwrapEffect(
  Effect.promise(ensureLogTapeConfigured).pipe(
    Effect.map(() =>
      Layer.merge(
        Logger.replace(Logger.defaultLogger, logtapeLogger),
        Logger.minimumLogLevel(LogLevel.All), // 全放行，由 LogTape 过滤
      ),
    ),
  ),
);
