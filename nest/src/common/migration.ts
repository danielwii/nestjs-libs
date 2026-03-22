import { SysEnv } from '@app/env';
import { getAppLogger } from '@app/utils/app-logger';

import { execSync } from 'node:child_process';

const logger = getAppLogger('Migration');

/**
 * 自动执行 Prisma migration（PRISMA_MIGRATION=true 时）
 *
 * 在 NestFactory.create 之前调用，确保 DB schema 与代码一致。
 * 使用 Prisma CLI（自动读取 DATABASE_URL），不需要 PrismaClient 实例。
 */
export function doMigration() {
  if (!SysEnv.PRISMA_MIGRATION) {
    logger.info`🚉 Migration: disabled (PRISMA_MIGRATION=${SysEnv.PRISMA_MIGRATION ?? 'undefined'})`;
    return;
  }

  logger.info`🚉 Migration: enabled — executing before Nest initialization`;
  try {
    execSync('bun prisma migrate status', { stdio: 'inherit' });
  } catch {
    logger.warning`🚉 migrate status failed (may be first run)`;
  }

  logger.info`🚉 Applying Migrations...`;
  execSync('bun prisma migrate deploy', { stdio: 'inherit' });
  logger.info`🚉 Migration: completed`;
}
