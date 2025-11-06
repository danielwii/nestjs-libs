import { execSync } from 'child_process';
import _ from 'lodash';

import { Logger } from '@nestjs/common';
import { SysEnv } from '@app/env';
import { f } from '@app/utils';

const logger = new Logger('Migration');
export async function doMigration() {
  if (SysEnv.PRISMA_MIGRATION) {
    logger.log('🚉 ------- MIGRATION MODE -------');
    try {
      execSync('bun prisma migrate status', { stdio: 'inherit' });
      // eslint-disable-next-line no-empty, @typescript-eslint/no-unused-vars
    } catch (e: unknown) {}
    const { PrismaClient } = await import('@/generated/prisma/client');
    const prisma = new PrismaClient();
    await prisma.$connect();
    let applied: number | null = null;
    try {
      applied = await prisma.$executeRaw`SELECT count(*) as cnt from "_prisma_migrations"`;
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
