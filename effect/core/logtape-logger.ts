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

import { r } from '@app/utils/logging';

import { getAppLogger } from './app-logger';

import { configure, getConsoleSink } from '@logtape/logtape';
import { context, trace } from '@opentelemetry/api';
import { Cause, Effect, Layer, Logger, LogLevel } from 'effect';

// ==================== ANSI Colors ====================

const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  // Level colors
  trace: '\x1b[2m', // dim
  debug: '\x1b[34m', // blue
  info: '\x1b[32m', // green
  warning: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
} as const;

// ==================== Effect Logger → LogTape Bridge ====================

const logtapeLogger = Logger.make(({ logLevel, message, cause, annotations, spans }) => {
  const props: Record<string, unknown> = {};

  // Effect annotations → LogTape properties
  if (annotations && Symbol.iterator in annotations) {
    for (const [k, v] of annotations as Iterable<[string, unknown]>) {
      props[k] = v;
    }
  }

  // Effect log spans (from Effect.withLogSpan) → spanName
  if (spans && Symbol.iterator in spans) {
    for (const span of spans as Iterable<{ label: string }>) {
      props['spanName'] = span.label;
      break;
    }
  }

  // OTel context fallback
  if (!props['traceId'] || !props['spanName'] || !props['userId']) {
    const span = trace.getSpan(context.active());
    if (span) {
      if (!props['traceId']) props['traceId'] = span.spanContext().traceId;
      // as unknown: OTel Span 接口不暴露 name/attributes，但运行时存在。
      // 这是 @opentelemetry/api 的已知限制，无公开 API 获取这些字段。
      if (!props['spanName']) props['spanName'] = (span as unknown as { name?: string }).name;
      if (!props['userId']) {
        const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
        const uid = attrs?.['user.id'];
        if (typeof uid === 'string' && uid.trim().length > 0) props['userId'] = uid;
      }
    }
  }

  // Route to LogTape logger with module as child category
  const category = (props['module'] as string) ?? (props['service'] as string) ?? undefined;
  const baseLogger = getAppLogger();
  const logger = category ? baseLogger.getChild(category).with(props) : baseLogger.with(props);

  // Render message: non-string values go through r() for inspect coloring
  const parts = Array.isArray(message) ? message : [message];
  let msg = parts.map((p) => (typeof p === 'string' ? p : r(p))).join(' ');

  // Append cause if present (Effect Cause contains the actual error on fiber failure)
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

// ==================== Dev Formatter ====================

/** `2026-03-16 15:00:00.022+09:00` */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');

  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;

  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const tz = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;

  return `${date} ${time}${tz}`;
}

/** Level label → ANSI colored full uppercase */
function colorLevel(level: string): string {
  const upper = level.toUpperCase().padEnd(7); // 'WARNING' is longest (7)
  const color = ansi[level as keyof typeof ansi] ?? ansi.info;
  return `${ansi.bold}${color}${upper}${ansi.reset}`;
}

/**
 * Dev formatter — 直接控制布局，无 regex hack
 *
 * `2026-03-16 15:00:00.022+09:00 INFO    [spanName|traceId|userId] unee-mcp·Prisma: message`
 */
function devFormatter(record: {
  readonly timestamp: number;
  readonly level: string;
  readonly category: readonly string[];
  readonly message: readonly unknown[];
  readonly rawMessage: string | TemplateStringsArray;
  readonly properties: Record<string, unknown>;
}): string {
  const timestamp = `${ansi.dim}${formatTimestamp(record.timestamp)}${ansi.reset}`;
  const level = colorLevel(record.level);
  const category = `${ansi.dim}${record.category.join('·')}:${ansi.reset}`;

  // Context tag: [spanName|traceId|userId]
  const contextParts: string[] = [];
  const { traceId, userId, spanName } = record.properties;
  if (spanName && typeof spanName === 'string') contextParts.push(spanName);
  if (traceId && typeof traceId === 'string') contextParts.push(traceId);
  if (userId && typeof userId === 'string' && userId.trim().length > 0) contextParts.push(userId);
  const contextTag = contextParts.length > 0 ? `${ansi.cyan}[${contextParts.join('|')}]${ansi.reset} ` : '';

  // Message: non-string values through r() for type-aware rendering
  // Error objects: error/fatal → with stack trace, warning → message only
  const isErrorLevel = record.level === 'error' || record.level === 'fatal';
  const renderValue = (p: unknown): string => {
    if (typeof p === 'string') return p;
    if (p instanceof Error) {
      return isErrorLevel ? r(p) : p.message;
    }
    return r(p);
  };
  const raw = Array.isArray(record.message) ? record.message.map(renderValue).join('') : String(record.message);
  const levelColor = ansi[record.level as keyof typeof ansi] ?? '';
  const message = levelColor ? `${levelColor}${raw.replaceAll(ansi.reset, ansi.reset + levelColor)}${ansi.reset}` : raw;

  return `${timestamp} ${level} ${contextTag}${category} ${message}`;
}

// ==================== LogTape Configuration ====================

/**
 * Prod formatter — JSON lines for log aggregation (Loki/CloudWatch)
 *
 * 自定义而非 getJsonLinesFormatter，因为 LogTape 的 rendered message 会双重引号。
 */
function prodFormatter(record: {
  readonly timestamp: number;
  readonly level: string;
  readonly category: readonly string[];
  readonly message: readonly unknown[];
  readonly rawMessage: string | TemplateStringsArray;
  readonly properties: Record<string, unknown>;
}): string {
  const message = Array.isArray(record.message)
    ? record.message.map((p) => (typeof p === 'string' ? p : String(p))).join('')
    : String(record.message);

  const entry: Record<string, unknown> = {
    '@timestamp': new Date(record.timestamp).toISOString(),
    level: record.level.toUpperCase(),
    message,
    logger: record.category.join('.'),
  };

  // Flatten properties (module, traceId, userId, spanName)
  for (const [k, v] of Object.entries(record.properties)) {
    if (v !== undefined && v !== null) entry[k] = v;
  }

  return JSON.stringify(entry);
}

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
