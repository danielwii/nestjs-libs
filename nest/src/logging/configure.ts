import { devFormatter, prodFormatter } from '@app/utils/log-formatter';

import { configure, getConsoleSink } from '@logtape/logtape';

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
 * Dev: shared devFormatter (full level name, direct layout)
 * Prod: shared prodFormatter (JSON lines for log aggregation)
 */
export async function configureLogging(nestLevel?: LogLevel): Promise<void> {
  if (configured) return;
  configured = true;

  const isProd = process.env.NODE_ENV === 'production';
  const lowestLevel = nestLevel ? nestToLogtapeLevel[nestLevel] : 'debug';

  await configure({
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
