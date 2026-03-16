/**
 * LogTape-backed Effect Logger
 *
 * 将 Effect.log 委托给 LogTape，统一日志格式：
 * - dev: `2026-03-13 10:54:00.022+09:00 INF [spanName|traceId|userId] app·Prisma: message`
 * - prod: JSON lines（LogTape jsonLinesFormatter）
 *
 * Effect 的 annotations/spans 自动映射为 LogTape properties，
 * 由 LogTape dev formatter 的 `[context]` 标签展示。
 *
 * 替代 Effect 内置的 prettyLogger/jsonLogger，让所有日志走统一的 LogTape pipeline。
 */

import { Effect, Layer, Logger, LogLevel } from 'effect';

import { configure, getAnsiColorFormatter, getConsoleSink, getJsonLinesFormatter, getLogger, lazy } from '@logtape/logtape';
import { context, trace } from '@opentelemetry/api';

import { r } from '@app/utils/logging';

import { getAppLogger } from './app-logger';

// ==================== Logger Implementation ====================

/**
 * Effect Logger → LogTape 桥接
 *
 * 提取 Effect 的 annotations（annotateLogs）和 spans（withSpan）
 * 作为 LogTape properties 传递，由 LogTape formatter 统一格式化。
 */
const logtapeLogger = Logger.make(({ logLevel, message, annotations, spans }) => {
  // Effect annotations → LogTape properties
  const props: Record<string, unknown> = {};

  // HashMap<string, unknown> → Record
  if (annotations && Symbol.iterator in annotations) {
    for (const [k, v] of annotations as Iterable<[string, unknown]>) {
      props[k] = v;
    }
  }

  // Effect log spans (from Effect.withLogSpan) → spanName
  if (spans && Symbol.iterator in spans) {
    for (const span of spans as Iterable<{ label: string }>) {
      props['spanName'] = span.label;
      break; // 只取最近的
    }
  }

  // OTel context 注入（和 NestJS LogtapeNestLogger 一致）
  // Effect annotations 优先，OTel span 回退
  if (!props['traceId']) {
    const span = trace.getSpan(context.active());
    if (span) props['traceId'] = span.spanContext().traceId;
  }
  if (!props['spanName']) {
    const span = trace.getSpan(context.active());
    if (span) props['spanName'] = (span as unknown as { name?: string }).name;
  }
  if (!props['userId']) {
    const span = trace.getSpan(context.active());
    if (span) {
      const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
      const uid = attrs?.['user.id'];
      if (typeof uid === 'string' && uid.trim().length > 0) props['userId'] = uid;
    }
  }

  // 提取 category（从 annotations 的 "module" 或 "service"）
  const category = (props['module'] as string) ?? (props['service'] as string) ?? undefined;
  const baseLogger = getAppLogger();
  const logger = category ? baseLogger.getChild(category).with(props) : baseLogger.with(props);

  // Effect message 是 unknown[]，每个元素保留原始类型
  // 拼接为 LogTape 消息，让 value: r 处理类型着色
  const parts = Array.isArray(message) ? message : [message];
  const msg = parts.map((p) => (typeof p === 'string' ? p : r(p))).join(' ');

  // Effect LogLevel → LogTape method
  if (LogLevel.greaterThanEqual(logLevel, LogLevel.Fatal)) {
    logger.fatal`${msg}`;
  } else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Error)) {
    logger.error`${msg}`;
  } else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Warning)) {
    logger.warning`${msg}`;
  } else if (LogLevel.greaterThanEqual(logLevel, LogLevel.Info)) {
    logger.info`${msg}`;
  } else {
    logger.debug`${msg}`;
  }
});


// ==================== LogTape Configuration ====================

/** Local timestamp: `2026-03-13 10:54:00.022+09:00` */
function formatLocalTimestamp(ts: number): string {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const oh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const om = String(absOffset % 60).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}${sign}${oh}:${om}`;
}

/**
 * 初始化 LogTape sinks
 *
 * dev: ansiColor + local timestamp + ABBR level
 * prod: JSON lines (flatten properties, rendered message)
 */
/**
 * Dev formatter: wraps ansiColorFormatter, injects [context] between level and category.
 *
 * Output: `2026-03-13 10:54:00.022+09:00 INF [spanName|traceId|userId] app·Prisma: message`
 */
function createDevFormatter() {
  // value: String — 不对插值二次着色，着色由 f 模板或 r 在 Effect Logger 层完成
  const baseFormatter = getAnsiColorFormatter({ timestamp: formatLocalTimestamp, level: 'ABBR', value: String });

  // Match: "YYYY-MM-DD HH:MM:SS.mmm±HH:MM LVL " → timestamp + 3-letter level + space
  const levelEndRegex = /^(.+? [A-Z]{3}) /;

  return (record: Parameters<typeof baseFormatter>[0]): string => {
    const base = baseFormatter(record);

    // Build context tag from record properties (set by Effect annotateLogs / withSpan)
    const parts: string[] = [];
    const { traceId, userId, spanName } = record.properties;
    if (spanName && typeof spanName === 'string') parts.push(spanName);
    if (traceId && typeof traceId === 'string') parts.push(traceId);
    if (userId && typeof userId === 'string' && userId.trim().length > 0) parts.push(userId);

    if (parts.length === 0) return base;

    const contextTag = `\x1b[36m[${parts.join('|')}]\x1b[0m`; // cyan

    // Insert context tag between level and category
    const firstNewline = base.indexOf('\n');
    const line = firstNewline >= 0 ? base.slice(0, firstNewline) : base;
    const trailing = firstNewline >= 0 ? base.slice(firstNewline) : '';

    // Strip ANSI codes for matching, then insert at the right position
    // eslint-disable-next-line no-control-regex
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const match = levelEndRegex.exec(plain);
    if (!match) return `${contextTag} ${base}`;

    // Find the position in the original (ANSI) string after "LEVEL "
    const plainPrefix = match[0];
    let ansiPos = 0;
    let plainPos = 0;
    while (plainPos < plainPrefix.length && ansiPos < line.length) {
      if (line[ansiPos] === '\x1b') {
        const escEnd = line.indexOf('m', ansiPos);
        ansiPos = escEnd >= 0 ? escEnd + 1 : ansiPos + 1;
      } else {
        plainPos++;
        ansiPos++;
      }
    }

    return `${line.slice(0, ansiPos)}${contextTag} ${line.slice(ansiPos)}${trailing}`;
  };
}

const ensureLogTapeConfigured = (() => {
  let configured = false;
  return async () => {
    if (configured) return;
    configured = true;

    const isProd = process.env.NODE_ENV === 'production';
    await configure({
      sinks: {
        console: getConsoleSink({
          formatter: isProd
            ? getJsonLinesFormatter({ properties: 'flatten', message: 'rendered' })
            : createDevFormatter(),
        }),
      },
      loggers: [
        { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
        { category: [], sinks: ['console'], lowestLevel: 'debug' },
      ],
    });
  };
})();

// ==================== Layers ====================

/**
 * 用 LogTape 替换 Effect 默认 Logger
 *
 * 自动初始化 LogTape sinks（幂等）。
 */
export const LogTapeLoggerLayer = Layer.unwrapEffect(
  Effect.promise(ensureLogTapeConfigured).pipe(
    Effect.map(() => Logger.replace(Logger.defaultLogger, logtapeLogger)),
  ),
);

/**
 * LogTape Logger + 日志级别控制
 *
 * 替代 FullLoggerLayer，统一走 LogTape pipeline。
 */
export const LogTapeFullLoggerLayer = (level?: string): Layer.Layer<never> => {
  const effectiveLevel = level ?? process.env.LOG_LEVEL ?? 'debug';
  return Layer.merge(LogTapeLoggerLayer, logLevelLayer(effectiveLevel));
};

/** Effect LogLevel 映射 */
const parseLogLevel = (level: string): LogLevel.LogLevel => {
  switch (level) {
    case 'verbose':
    case 'debug':
      return LogLevel.Debug;
    case 'log':
      return LogLevel.Info;
    case 'warn':
      return LogLevel.Warning;
    case 'error':
      return LogLevel.Error;
    case 'fatal':
      return LogLevel.Fatal;
    default:
      return LogLevel.Debug;
  }
};

const logLevelLayer = (level: string): Layer.Layer<never> => Logger.minimumLogLevel(parseLogLevel(level));
