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

  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: isProd
          ? getJsonLinesFormatter({ properties: 'flatten', message: 'rendered' })
          : createDevFormatter(),
      }),
    },
    loggers: [
      // 抑制 LogTape 自身的 meta 提示（"LogTape loggers are configured..."）
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      { category: [], sinks: ['console'], lowestLevel },
    ],
  });
}

/** Local timestamp with timezone offset: `2026-03-13 10:54:00.022+09:00` */
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
 * Dev formatter: wraps ansiColorFormatter, injects [context] between level and category.
 *
 * Output: `2026-03-13 10:54:00.022+09:00 DBG [spanName|traceId|userId] app·LockService: message`
 */
function createDevFormatter() {
  // value: r 复用 @app/utils/logging 的格式化逻辑——对象用 inspect，Error 用 onelineStack
  const baseFormatter = getAnsiColorFormatter({ timestamp: formatLocalTimestamp, level: 'ABBR', value: r });

  // Match: "YYYY-MM-DD HH:MM:SS.mmm±HH:MM LVL " → timestamp + 3-letter level + space
  const levelEndRegex = /^(.+? [A-Z]{3}) /;

  return (record: Parameters<typeof baseFormatter>[0]): string => {
    const base = baseFormatter(record);

    // Build context tag from record properties (set by lazy() in LogtapeNestLogger)
    const parts: string[] = [];
    const { traceId, userId, spanName, contextTags } = record.properties;
    if (traceId && typeof traceId === 'string') parts.push(traceId);
    if (spanName && typeof spanName === 'string') parts.push(spanName);
    if (userId && typeof userId === 'string' && userId.trim().length > 0) parts.push(userId);
    // 额外 context tags（来自 RequestContext 的非标准字段）
    if (Array.isArray(contextTags)) {
      for (const tag of contextTags) {
        if (typeof tag === 'string') parts.push(tag);
      }
    }

    if (parts.length === 0) return base;

    const contextTag = `[${parts.join('|')}]`;

    // Insert context tag between level and category
    const firstNewline = base.indexOf('\n');
    const line = firstNewline >= 0 ? base.slice(0, firstNewline) : base;
    const trailing = firstNewline >= 0 ? base.slice(firstNewline) : '';

    // Strip ANSI codes for matching, then insert at the right position
    // eslint-disable-next-line no-control-regex -- stripping ANSI escape sequences
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const match = levelEndRegex.exec(plain);
    if (!match) return `${contextTag} ${base}`;

    // Find the position in the original (ANSI) string after "LEVEL "
    // Count characters consumed: match[0] length in plain text
    const plainPrefix = match[0]; // e.g. "10:54:00.022 DBG "
    let ansiPos = 0;
    let plainPos = 0;
    while (plainPos < plainPrefix.length && ansiPos < line.length) {
      if (line[ansiPos] === '\x1b') {
        // Skip ANSI escape sequence
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
