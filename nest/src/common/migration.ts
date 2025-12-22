import { Logger } from '@nestjs/common';

import { SysEnv } from '@app/env';

import { execSync } from 'node:child_process';

import _ from 'lodash';

const logger = new Logger('Migration');

export interface IPrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $executeRaw(query: TemplateStringsArray, ...args: unknown[]): Promise<unknown>;
}

export async function doMigration(PrismaClient: new (...args: unknown[]) => IPrismaClientLike) {
  if (SysEnv.PRISMA_MIGRATION) {
    logger.log('🚉 ------- MIGRATION MODE -------');
    try {
      execSync('bun prisma migrate status', { stdio: 'inherit' });
      // eslint-disable-next-line no-empty
    } catch (_e: unknown) {}
    const prisma = new PrismaClient();
    await prisma.$connect();
    let applied: number | null = null;
    try {
      applied = (await prisma.$executeRaw`SELECT count(*) as cnt from "_prisma_migrations"`) as number;
    } catch (e: unknown) {
      const notFound = e instanceof Error && _.includes(e.message, 'relation "_prisma_migrations" does not exist');
      if (notFound) applied = -1;
      logger.log(`🚉 Migration Table Exists: ${!notFound}`);
    }
    logger.log(`🚉 Applied Migrations: ${applied}`);
    await prisma.$disconnect();

    logger.log('🚉 Applying Migrations...');
    const output = execSync('bun prisma migrate deploy', { stdio: 'inherit' });
    if (output) logger.log(`🚉 ${output.toString()}`);
    logger.log(`🚉 ------- Finished Applying Migrations -------`);
  }
}
