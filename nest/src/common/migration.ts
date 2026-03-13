import { SysEnv } from '@app/env';

import { execSync } from 'node:child_process';

import { getLogger } from '@logtape/logtape';

const logger = getLogger(['app', 'Migration']);

export interface IPrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $executeRaw(query: TemplateStringsArray, ...args: unknown[]): Promise<unknown>;
}

export async function doMigration(PrismaClient: new (...args: unknown[]) => IPrismaClientLike) {
  if (SysEnv.PRISMA_MIGRATION) {
    logger.info`🚉 ------- MIGRATION MODE -------`;
    try {
      execSync('bun prisma migrate status', { stdio: 'inherit' });
      // eslint-disable-next-line no-empty
    } catch {}
    const prisma = new PrismaClient();
    await prisma.$connect();
    let applied: number | null = null;
    try {
      applied = (await prisma.$executeRaw`SELECT count(*) as cnt from "_prisma_migrations"`) as number;
    } catch (e: unknown) {
      const notFound = e instanceof Error && e.message.includes('relation "_prisma_migrations" does not exist');
      if (notFound) applied = -1;
      logger.info`🚉 Migration Table Exists: ${!notFound}`;
    }
    logger.info`🚉 Applied Migrations: ${applied}`;
    await prisma.$disconnect();

    logger.info`🚉 Applying Migrations...`;
    execSync('bun prisma migrate deploy', { stdio: 'inherit' });
    logger.info`🚉 ------- Finished Applying Migrations -------`;
  }
}
