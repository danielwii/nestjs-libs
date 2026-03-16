/**
 * 统一 Logger 工厂
 *
 * 基于 APP_NAME 环境变量创建 LogTape logger，
 * 所有模块通过 getAppLogger('ModuleName') 获取带命名空间的 logger。
 *
 * 输出格式：
 * - dev:  `2026-03-16 15:00:00.000+09:00 INF unee-mcp·Prisma: message`
 * - prod: JSON lines with appName field
 *
 * 统一了以下概念：
 * - LogTape root category
 * - Sentry serverName (APP_NAME)
 * - OTel service.name (OTEL_SERVICE_NAME ?? APP_NAME)
 * - Effect ServiceName config
 * - Startup banner serviceName
 */

import { getLogger } from '@logtape/logtape';

import type { Logger } from '@logtape/logtape';

/** 应用名称（唯一来源） */
export const APP_NAME = process.env.APP_NAME ?? process.env.SERVICE_NAME ?? 'app';

/**
 * 获取带模块命名空间的 logger
 *
 * @example
 * ```ts
 * const logger = getAppLogger('Prisma');
 * logger.info`connected`;  // → unee-mcp·Prisma: connected
 *
 * const logger = getAppLogger();
 * logger.info`starting`;   // → unee-mcp: starting
 * ```
 */
export function getAppLogger(module?: string): Logger {
  const base = getLogger([APP_NAME]);
  return module ? base.getChild(module) : base;
}
