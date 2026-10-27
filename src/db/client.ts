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

/** Kitchen Quiz tables: the song pool and the scores. */
export async function ensureQuizTables(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "PlayedTrack" (' +
      '"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
      '"guildId" TEXT NOT NULL, "url" TEXT NOT NULL, "title" TEXT NOT NULL, ' +
      '"uploader" TEXT, "thumbnail" TEXT, "durationSec" INTEGER NOT NULL DEFAULT 0, ' +
      '"requestedById" TEXT, "playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "PlayedTrack_guildId_url_key" ON "PlayedTrack"("guildId", "url")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PlayedTrack_guildId_playedAt_idx" ON "PlayedTrack"("guildId", "playedAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "QuizScore" (' +
      '"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
      '"guildId" TEXT NOT NULL, "userId" TEXT NOT NULL, "score" INTEGER NOT NULL, ' +
      '"correct" INTEGER NOT NULL, "rounds" INTEGER NOT NULL, ' +
      '"playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "QuizScore_guildId_playedAt_idx" ON "QuizScore"("guildId", "playedAt")',
  );
}

/** Every track start, including repeats and Kitchen FM. Counts and hours live here. */
export async function ensurePlayLogTable(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "PlayLog" (' +
      '"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
      '"guildId" TEXT NOT NULL, "url" TEXT NOT NULL, "title" TEXT NOT NULL, ' +
      '"artist" TEXT NOT NULL DEFAULT \'\', "songKey" TEXT NOT NULL, "requestedById" TEXT, ' +
      '"kind" TEXT NOT NULL, "durationSec" INTEGER NOT NULL DEFAULT 0, ' +
      '"playedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PlayLog_guildId_playedAt_idx" ON "PlayLog"("guildId", "playedAt")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PlayLog_guildId_songKey_idx" ON "PlayLog"("guildId", "songKey")',
  );
}

/** 🔥 and 👎 on Kitchen FM songs. One row per person per song. */
export async function ensureSongReactionTable(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "SongReaction" (' +
      '"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
      '"guildId" TEXT NOT NULL, "userId" TEXT NOT NULL, "songKey" TEXT NOT NULL, ' +
      '"url" TEXT NOT NULL, "title" TEXT NOT NULL, "artist" TEXT NOT NULL DEFAULT \'\', ' +
      '"kind" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
  );
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "SongReaction_guildId_userId_songKey_key" ON "SongReaction"("guildId", "userId", "songKey")',
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "SongReaction_guildId_songKey_idx" ON "SongReaction"("guildId", "songKey")',
  );
}

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
