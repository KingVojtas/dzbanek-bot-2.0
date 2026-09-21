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
  idleRadioEnabled: boolean;
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
    idleRadioEnabled: true,
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
    idleRadioEnabled: row.idleRadioEnabled,
  };
}

/** Per-guild channel config, stored in SQLite via Prisma. */
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
        idleRadioEnabled: next.idleRadioEnabled,
      },
    });
    return fromRow(row);
  }
}
