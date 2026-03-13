import { r } from '@app/utils/logging';

import { configure, getAnsiColorFormatter, getConsoleSink, getJsonLinesFormatter } from '@logtape/logtape';

import type { LogLevel as LogTapeLevel } from '@logtape/logtape';
import type { LogLevel } from '@nestjs/common';

/** NestJS LogLevel -> LogTape level */
const nestToLogtapeLevel: Record<LogLevel, LogTapeLevel> = {
  verbose: 'debug',
  debug: 'debug',
  log: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'fatal',
};

let configured = false;

/**
 * Initialize LogTape logging.
 *
 * Dev: ansi color formatter with appName pid prefix
 * Prod: JSON lines for log aggregation
 */
export async function configureLogging(nestLevel?: LogLevel): Promise<void> {
  if (configured) return;
  configured = true;

  const isProd = process.env.NODE_ENV === 'production';
  const lowestLevel = nestLevel ? nestToLogtapeLevel[nestLevel] : 'debug';

  const appName = process.env.APP_NAME ?? 'app';
  const prefix = `${appName} ${process.pid}`;

  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: isProd
          ? getJsonLinesFormatter({ properties: 'flatten', message: 'rendered' })
          : createDevFormatter(prefix),
      }),
    },
    loggers: [
      // 抑制 LogTape 自身的 meta 提示（"LogTape loggers are configured..."）
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      { category: [], sinks: ['console'], lowestLevel },
    ],
  });
}

/**
 * Dev formatter: wraps ansiColorFormatter, prepends appName pid,
 * and injects [traceId|userId|...] from LogRecord properties.
 */
function createDevFormatter(prefix: string) {
  // value: r 复用 @app/utils/logging 的格式化逻辑——对象用 inspect，Error 用 onelineStack
  const baseFormatter = getAnsiColorFormatter({ timestamp: 'time', level: 'ABBR', value: r });

  return (record: Parameters<typeof baseFormatter>[0]): string => {
    const base = baseFormatter(record);

    // Build context tag from record properties (set by lazy() in LogtapeNestLogger)
    const parts: string[] = [];
    const { traceId, userId, spanName } = record.properties;
    if (spanName && typeof spanName === 'string') parts.push(spanName);
    if (traceId && typeof traceId === 'string') parts.push(traceId);
    if (userId && typeof userId === 'string' && userId.trim().length > 0) parts.push(userId);
    const contextTag = parts.length > 0 ? ` [${parts.join('|')}]` : '';

    // ansiColorFormatter 已包含 timestamp + level + category + message + trailing newline
    // 在整行前加上 prefix + context tag
    const firstNewline = base.indexOf('\n');
    const line = firstNewline >= 0 ? base.slice(0, firstNewline) : base;
    const trailing = firstNewline >= 0 ? base.slice(firstNewline) : '';
    return `${prefix}${contextTag} ${line}${trailing}`;
  };
}
