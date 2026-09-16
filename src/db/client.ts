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

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
