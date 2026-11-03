import { devFormatter, prodFormatter, setActiveTraceIdResolver } from '@app/utils/log-formatter';

import { configure, getConsoleSink } from '@logtape/logtape';
import { context, trace } from '@opentelemetry/api';

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

/** The level LogTape is currently configured with; undefined until the first configureLogging call. */
let configuredLevel: LogTapeLevel | undefined;

/**
 * LOG_LEVEL as the process environment states it, limited to the values libs/env accepts; anything else is undefined.
 * Read here (not through SysEnv) because the preload (`instrument.ts`) configures logging before any app module loads.
 */
function envLogLevel(): LogLevel | undefined {
  const raw = process.env.LOG_LEVEL?.trim();
  return raw !== undefined && Object.hasOwn(nestToLogtapeLevel, raw) ? (raw as LogLevel) : undefined;
}

export function registerActiveTraceIdResolver(): void {
  setActiveTraceIdResolver(() => trace.getSpan(context.active())?.spanContext().traceId);
}

/**
 * Initialize LogTape logging.
 *
 * Dev: shared devFormatter (full level name, direct layout)
 * Prod: shared prodFormatter (JSON lines for log aggregation)
 *
 * Level: the explicit argument (bootstrap passes SysEnv.LOG_LEVEL), else LOG_LEVEL from the environment, else debug.
 * The preload calls this with no argument before the app loads, so the environment is read there too; a later call with a
 * different level reconfigures LogTape (reset) instead of being ignored — before, the first call pinned the level to debug
 * and LOG_LEVEL never took effect. Same level again is a no-op.
 */
export async function configureLogging(nestLevel?: LogLevel): Promise<void> {
  registerActiveTraceIdResolver();

  const lowestLevel = nestToLogtapeLevel[nestLevel ?? envLogLevel() ?? 'debug'];
  if (configuredLevel === lowestLevel) return;
  const reset = configuredLevel !== undefined;
  configuredLevel = lowestLevel;

  const isProd = process.env.NODE_ENV === 'production';

  await configure({
    reset,
    sinks: {
      console: getConsoleSink({
        formatter: isProd ? prodFormatter : devFormatter,
      }),
    },
    loggers: [
      // 抑制 LogTape 自身的 meta 提示（"LogTape loggers are configured..."）
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      { category: [], sinks: ['console'], lowestLevel },
    ],
  });
}
