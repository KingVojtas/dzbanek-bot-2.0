import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '@prisma/client';

declare global {
  var prisma: PrismaClient | undefined;
}

function sqliteUrl(): string {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  return pathToFileURL(path.join(process.cwd(), 'data', 'bot.db')).href;
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaLibSql({ url: sqliteUrl() });
  return new PrismaClient({
    adapter,
    log: process.env.LOG_LEVEL === 'debug' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = global.prisma ?? createPrismaClient();

/**
 * The Mac mini keeps its own SQLite file across deploys, and the container
 * does not run `prisma db push`. Add columns the current client selects.
 */
export async function ensureGuildSettingsColumns(): Promise<void> {
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    'PRAGMA table_info("GuildSettings")',
  );
  for (const name of ['lastRadioChannelId', 'wishlistChannelId']) {
    if (columns.some((column) => column.name === name)) continue;
    await prisma.$executeRawUnsafe(`ALTER TABLE "GuildSettings" ADD COLUMN "${name}" TEXT`);
  }
}

/** Same reason: the Wishlist Radar table has to exist before the first `/steam link`. */
export async function ensureSteamLinkTable(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "SteamLink" (' +
      '"userId" TEXT NOT NULL PRIMARY KEY, ' +
      '"steamId" TEXT NOT NULL, ' +
      '"linkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
}

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
