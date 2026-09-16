import { readFile, rename } from 'node:fs/promises';
import { logger } from '../core/logger';
import type { GuildSettings } from '../deals/guild-settings';
import { prisma } from './client';

interface JsonSeenFile {
  [scope: string]: { ids?: string[]; updatedAt?: string };
}

/**
 * One-shot import of leftover JSON stores into SQLite, then rename the files
 * so we do not import twice.
 */
export async function migrateJsonStoresIfNeeded(): Promise<void> {
  await migrateSeenFile('data/steam-seen.json');
  await migrateSeenFile('data/epic-seen.json');
  await migrateGuildSettingsFile('data/guild-settings.json');
}

async function migrateSeenFile(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return;
  }

  let parsed: JsonSeenFile;
  try {
    parsed = JSON.parse(raw) as JsonSeenFile;
  } catch {
    logger.warn(`Skip JSON migrate (invalid JSON): ${path}`);
    return;
  }

  let imported = 0;
  for (const [scope, bucket] of Object.entries(parsed)) {
    const ids = bucket?.ids?.filter(Boolean) ?? [];
    if (ids.length === 0) continue;
    for (const itemId of ids) {
      await prisma.dedupEntry.upsert({
        where: { scope_itemId: { scope, itemId } },
        create: { scope, itemId },
        update: {},
      });
      imported += 1;
    }
  }

  await rename(path, `${path}.migrated`).catch(() => {});
  logger.info(`Migrated ${imported} seen id(s) from ${path} into SQLite.`);
}

async function migrateGuildSettingsFile(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return;
  }

  let parsed: Record<string, Partial<GuildSettings>>;
  try {
    parsed = JSON.parse(raw) as Record<string, Partial<GuildSettings>>;
  } catch {
    logger.warn(`Skip JSON migrate (invalid JSON): ${path}`);
    return;
  }

  let imported = 0;
  for (const [guildId, row] of Object.entries(parsed)) {
    if (!guildId) continue;
    await prisma.guildSettings.upsert({
      where: { guildId },
      create: {
        guildId,
        steamEnabled: row.steamEnabled ?? true,
        steamChannelId: row.steamChannelId ?? null,
        epicEnabled: row.epicEnabled ?? true,
        epicChannelId: row.epicChannelId ?? null,
      },
      update: {
        steamEnabled: row.steamEnabled ?? true,
        steamChannelId: row.steamChannelId ?? null,
        epicEnabled: row.epicEnabled ?? true,
        epicChannelId: row.epicChannelId ?? null,
      },
    });
    imported += 1;
  }

  await rename(path, `${path}.migrated`).catch(() => {});
  logger.info(`Migrated ${imported} guild setting row(s) from ${path} into SQLite.`);
}
