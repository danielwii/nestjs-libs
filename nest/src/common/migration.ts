import { SysEnv } from '@app/env';
import { getAppLogger } from '@app/utils/app-logger';

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const logger = getAppLogger('Migration');

/**
 * 自动发现 prisma.config.ts 的位置
 *
 * 查找顺序：cwd → cwd 的子目录（contract/ 等常见位置）
 * 找到后返回 `--config <path>` 参数，否则返回空（让 Prisma 用默认路径）
 */
function resolvePrismaConfigArg(): string {
  const candidates = [path.resolve('prisma.config.ts'), path.resolve('contract', 'prisma.config.ts')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      logger.info`🚉 Found prisma config: ${candidate}`;
      return `--config ${candidate}`;
    }
  }
  return '';
}

/**
 * 自动执行 Prisma migration（PRISMA_MIGRATION=true 时）
 *
 * 在 NestFactory.create 之前调用，确保 DB schema 与代码一致。
 * 使用 Prisma CLI（自动读取 DATABASE_URL），不需要 PrismaClient 实例。
 * 自动发现 prisma.config.ts（支持 contract/ 子目录结构）。
 */
export function doMigration() {
  if (!SysEnv.PRISMA_MIGRATION) {
    logger.info`🚉 Migration: disabled (PRISMA_MIGRATION=${SysEnv.PRISMA_MIGRATION ?? 'undefined'})`;
    return;
  }

  logger.info`🚉 Migration: enabled — executing before Nest initialization`;
  const configArg = resolvePrismaConfigArg();

  try {
    execSync(`bun prisma migrate status ${configArg}`.trim(), { stdio: 'inherit' });
  } catch {
    logger.warning`🚉 migrate status failed (may be first run)`;
  }

  logger.info`🚉 Applying Migrations...`;
  execSync(`bun prisma migrate deploy ${configArg}`.trim(), { stdio: 'inherit' });
  logger.info`🚉 Migration: completed`;
}
