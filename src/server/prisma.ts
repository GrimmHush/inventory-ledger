import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Builds a PrismaClient backed by the `pg` driver adapter. Prisma 7's client no
 * longer reads the connection URL from `prisma.config.ts` (that config is for
 * the CLI/migrations only) — the runtime connection is supplied here via the
 * adapter. See https://pris.ly/d/prisma7-client-config.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
