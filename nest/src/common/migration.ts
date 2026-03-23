import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';

import '@app/nest/exceptions/oops-factories';

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
 * 检查是否有 pending migration
 *
 * `prisma migrate status` 退出码：0 = up to date，1 = 有 pending 或错误
 * 通过输出内容区分：包含 "Database schema is up to date" → 无 pending
 */
function hasPendingMigrations(configArg: string): boolean {
  try {
    const output = execSync(`bun prisma migrate status ${configArg}`.trim(), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output.includes('Database schema is up to date')) {
      return false;
    }
    // 退出码 0 但没有 up to date 文案 → 保守起见当作有 pending
    return true;
  } catch (error: unknown) {
    // 退出码 1 → 有 pending migration 或连接/解析错误
    if (error instanceof Error && 'stderr' in error) {
      const stderr = String((error as { stderr: unknown }).stderr);
      if (stderr) logger.warning`🚉 migrate status stderr: ${stderr}`;
    }
    return true;
  }
}

/**
 * 自动执行 Prisma migration（PRISMA_MIGRATION=true 时）
 *
 * 在 NestFactory.create 之前调用，确保 DB schema 与代码一致。
 * prisma.config.ts 的 datasource.url 优先读 DIRECT_DATABASE_URL（直连 PG），
 * fallback 到 DATABASE_URL。检测到 PgBouncer 时强制要求 DIRECT_DATABASE_URL。
 *
 * 优化：schema up to date 时跳过 deploy，避免 advisory lock 竞争。
 */
export function doMigration() {
  if (!SysEnv.PRISMA_MIGRATION) {
    logger.info`🚉 Migration: disabled (PRISMA_MIGRATION=${SysEnv.PRISMA_MIGRATION ?? 'undefined'})`;
    return;
  }

  // PgBouncer transaction mode 不支持 advisory lock，migration 必须直连 PG
  // 检测 DATABASE_URL 是否经过 PgBouncer（端口 6432 或 hostname 含 pgbouncer）
  const dbUrl = process.env.DATABASE_URL ?? '';
  const isPgBouncer = dbUrl.includes(':6432') || dbUrl.toLowerCase().includes('pgbouncer');
  if (isPgBouncer && !process.env.DIRECT_DATABASE_URL) {
    throw Oops.Panic.Config(
      'DATABASE_URL points to PgBouncer but DIRECT_DATABASE_URL is not set. ' +
        'PgBouncer transaction mode does not support advisory locks required by prisma migrate. ' +
        'Set DIRECT_DATABASE_URL to a direct PostgreSQL connection.',
    );
  }

  logger.info`🚉 Migration: enabled — executing before Nest initialization`;
  const configArg = resolvePrismaConfigArg();

  if (!hasPendingMigrations(configArg)) {
    logger.info`🚉 Schema is up to date, skipping deploy`;
    return;
  }

  logger.info`🚉 Pending migrations detected, deploying...`;
  execSync(`bun prisma migrate deploy ${configArg}`.trim(), { stdio: 'inherit' });
  logger.info`🚉 Migration: completed`;
}
