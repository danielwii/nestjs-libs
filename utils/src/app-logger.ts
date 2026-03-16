/**
 * 统一日志工厂
 *
 * 封装日志框架（当前 LogTape），对外暴露与框架无关的 API。
 * 切换日志框架只改这个文件。
 *
 * APP_NAME 作为所有日志的根 category，统一：
 * - LogTape root category
 * - Sentry serverName
 * - OTel service.name
 * - Effect ServiceName
 * - Startup banner
 */

import { getLogger } from '@logtape/logtape';

import type { Logger } from '@logtape/logtape';

export type { Logger } from '@logtape/logtape';

/** 应用名称（唯一来源） */
export const APP_NAME = process.env.APP_NAME ?? process.env.SERVICE_NAME ?? 'app';

/**
 * 获取带模块命名空间的 logger
 *
 * 支持多级子模块，自动以 APP_NAME 为根。
 *
 * @example
 * ```ts
 * import { getAppLogger } from '@app/utils/app-logger';
 *
 * const logger = getAppLogger('Prisma');
 * logger.info`connected`;           // → unee-mcp·Prisma: connected
 *
 * const logger = getAppLogger('gRPC', 'Client');
 * logger.warning`timeout`;          // → unee-mcp·gRPC·Client: timeout
 *
 * const logger = getAppLogger();
 * logger.info`starting`;            // → unee-mcp: starting
 * ```
 */
export function getAppLogger(...modules: string[]): Logger {
  return getLogger([APP_NAME, ...modules]);
}
