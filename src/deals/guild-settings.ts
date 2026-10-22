import { prisma } from '../db/client';

export interface GuildSettings {
  guildId: string;
  steamEnabled: boolean;
  steamChannelId: string | null;
  epicEnabled: boolean;
  epicChannelId: string | null;
  welcomeEnabled: boolean;
  welcomeChannelId: string | null;
  goodbyeEnabled: boolean;
  goodbyeChannelId: string | null;
  kitchenEnabled: boolean;
  kitchenChannelId: string | null;
  kitchenMessageId: string | null;
  kitchenJoinDate: string | null;
  kitchenJoinCount: number;
  radioNightEnabled: boolean;
  radioNightChannelId: string | null;
  radioNightStation: string | null;
  lastRadioStation: string | null;
  lastRadioChannelId: string | null;
  idleRadioEnabled: boolean;
  wishlistChannelId: string | null;
}

function defaults(guildId: string): GuildSettings {
  return {
    guildId,
    steamEnabled: true,
    steamChannelId: null,
    epicEnabled: true,
    epicChannelId: null,
    welcomeEnabled: true,
    welcomeChannelId: null,
    goodbyeEnabled: true,
    goodbyeChannelId: null,
    kitchenEnabled: true,
    kitchenChannelId: null,
    kitchenMessageId: null,
    kitchenJoinDate: null,
    kitchenJoinCount: 0,
    radioNightEnabled: false,
    radioNightChannelId: null,
    radioNightStation: null,
    lastRadioStation: null,
    lastRadioChannelId: null,
    idleRadioEnabled: true,
    wishlistChannelId: null,
  };
}

function fromRow(row: GuildSettings): GuildSettings {
  return {
    guildId: row.guildId,
    steamEnabled: row.steamEnabled,
    steamChannelId: row.steamChannelId,
    epicEnabled: row.epicEnabled,
    epicChannelId: row.epicChannelId,
    welcomeEnabled: row.welcomeEnabled,
    welcomeChannelId: row.welcomeChannelId,
    goodbyeEnabled: row.goodbyeEnabled,
    goodbyeChannelId: row.goodbyeChannelId,
    kitchenEnabled: row.kitchenEnabled,
    kitchenChannelId: row.kitchenChannelId,
    kitchenMessageId: row.kitchenMessageId,
    kitchenJoinDate: row.kitchenJoinDate,
    kitchenJoinCount: row.kitchenJoinCount,
    radioNightEnabled: row.radioNightEnabled,
    radioNightChannelId: row.radioNightChannelId,
    radioNightStation: row.radioNightStation,
    lastRadioStation: row.lastRadioStation,
    lastRadioChannelId: row.lastRadioChannelId,
    idleRadioEnabled: row.idleRadioEnabled,
    wishlistChannelId: row.wishlistChannelId,
  };
}

/**
 * Per-guild channel config, stored in SQLite via Prisma. The bot is the only
 * writer, so reads come from a write-through cache: every voice change, board
 * tick, and vote used to be a database read.
 */
export class GuildSettingsStore {
  private readonly cache = new Map<string, GuildSettings>();
  /** True once every row is in the cache, so all() can skip the database. */
  private loadedAll = false;

  async get(guildId: string): Promise<GuildSettings> {
    const hit = this.cache.get(guildId);
    if (hit) return { ...hit };
    if (this.loadedAll) return defaults(guildId);
    const row = await prisma.guildSettings.findUnique({ where: { guildId } });
    if (!row) return defaults(guildId);
    const settings = fromRow(row);
    this.cache.set(guildId, settings);
    return { ...settings };
  }

  async all(): Promise<GuildSettings[]> {
    if (!this.loadedAll) {
      const rows = await prisma.guildSettings.findMany();
      for (const row of rows) this.cache.set(row.guildId, fromRow(row));
      this.loadedAll = true;
    }
    return [...this.cache.values()].map((settings) => ({ ...settings }));
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
        welcomeEnabled: next.welcomeEnabled,
        welcomeChannelId: next.welcomeChannelId,
        goodbyeEnabled: next.goodbyeEnabled,
        goodbyeChannelId: next.goodbyeChannelId,
        kitchenEnabled: next.kitchenEnabled,
        kitchenChannelId: next.kitchenChannelId,
        kitchenMessageId: next.kitchenMessageId,
        kitchenJoinDate: next.kitchenJoinDate,
        kitchenJoinCount: next.kitchenJoinCount,
        radioNightEnabled: next.radioNightEnabled,
        radioNightChannelId: next.radioNightChannelId,
        radioNightStation: next.radioNightStation,
        lastRadioStation: next.lastRadioStation,
        lastRadioChannelId: next.lastRadioChannelId,
        idleRadioEnabled: next.idleRadioEnabled,
        wishlistChannelId: next.wishlistChannelId,
      },
    });
    const saved = fromRow(row);
    this.cache.set(guildId, saved);
    return { ...saved };
  }
}
