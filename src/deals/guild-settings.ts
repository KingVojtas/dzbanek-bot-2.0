import { prisma } from '../db/client';

export interface GuildSettings {
  guildId: string;
  steamEnabled: boolean;
  steamChannelId: string | null;
  epicEnabled: boolean;
  epicChannelId: string | null;
}

function defaults(guildId: string): GuildSettings {
  return {
    guildId,
    steamEnabled: true,
    steamChannelId: null,
    epicEnabled: true,
    epicChannelId: null,
  };
}

function fromRow(row: {
  guildId: string;
  steamEnabled: boolean;
  steamChannelId: string | null;
  epicEnabled: boolean;
  epicChannelId: string | null;
}): GuildSettings {
  return {
    guildId: row.guildId,
    steamEnabled: row.steamEnabled,
    steamChannelId: row.steamChannelId,
    epicEnabled: row.epicEnabled,
    epicChannelId: row.epicChannelId,
  };
}

/** Per-guild Steam/Epic channel config, stored in SQLite via Prisma. */
export class GuildSettingsStore {
  async get(guildId: string): Promise<GuildSettings> {
    const row = await prisma.guildSettings.findUnique({ where: { guildId } });
    return row ? fromRow(row) : defaults(guildId);
  }

  async all(): Promise<GuildSettings[]> {
    const rows = await prisma.guildSettings.findMany();
    return rows.map(fromRow);
  }

  async upsert(
    guildId: string,
    patch: Partial<Omit<GuildSettings, 'guildId'>>,
  ): Promise<GuildSettings> {
    const current = await this.get(guildId);
    const next: GuildSettings = { ...current, ...patch, guildId };
    const row = await prisma.guildSettings.upsert({
      where: { guildId },
      create: next,
      update: {
        steamEnabled: next.steamEnabled,
        steamChannelId: next.steamChannelId,
        epicEnabled: next.epicEnabled,
        epicChannelId: next.epicChannelId,
      },
    });
    return fromRow(row);
  }
}
