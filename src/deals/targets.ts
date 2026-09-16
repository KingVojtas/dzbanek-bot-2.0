import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type SendableChannels,
} from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { GuildSettings, GuildSettingsStore } from './guild-settings';

export type DealKind = 'steam' | 'epic';

export interface DealTarget {
  guildId: string;
  guildName: string;
  channel: SendableChannels;
  settings: GuildSettings;
}

const STEAM_NAME_HINTS = [
  'steam',
  'steam-deals',
  'steamdeals',
  'steam-sales',
  'deals',
  'game-deals',
  'gamedeals',
  'slevy',
  'akce',
];

const EPIC_NAME_HINTS = [
  'epic',
  'epic-games',
  'epicgames',
  'free-games',
  'freegames',
  'epic-free',
  'freebies',
];

function hintsFor(kind: DealKind): string[] {
  return kind === 'steam' ? STEAM_NAME_HINTS : EPIC_NAME_HINTS;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function resolveGuildSendableChannel(
  client: Client,
  channelId: string,
  expectedGuildId: string,
): Promise<SendableChannels | null> {
  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isSendable() || channel.isDMBased()) return null;
  if (!('guildId' in channel) || channel.guildId !== expectedGuildId) return null;
  return channel;
}

export async function findChannelByNameHints(
  guild: Guild,
  rawHints: string[],
): Promise<SendableChannels | null> {
  await guild.channels.fetch().catch(() => null);
  const hints = rawHints.map(normalize);
  const me = guild.members.me;

  for (const channel of guild.channels.cache.values()) {
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      continue;
    }
    if (!channel.isSendable()) continue;
    const name = normalize(channel.name);
    if (!hints.some((hint) => name === hint || name.includes(hint))) continue;
    if (me) {
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
        continue;
      }
    }
    return channel;
  }
  return null;
}

async function findChannelByName(guild: Guild, kind: DealKind): Promise<SendableChannels | null> {
  return findChannelByNameHints(guild, hintsFor(kind));
}

/**
 * Map a legacy config.json channel ID onto the guild that actually owns it.
 */
export async function seedLegacyChannel(
  client: Client,
  settings: GuildSettingsStore,
  channelId: string | null,
  kind: DealKind,
  logger: Logger,
): Promise<void> {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || !('guildId' in channel) || !channel.guildId) return;
  if (!channel.isSendable()) return;

  const guildId = channel.guildId;
  const current = await settings.get(guildId);
  const field = kind === 'steam' ? 'steamChannelId' : 'epicChannelId';
  if (current[field]) return;

  await settings.upsert(guildId, {
    [field]: channelId,
    ...(kind === 'steam' ? { steamEnabled: true } : { epicEnabled: true }),
  });
  logger.info(
    `${kind === 'steam' ? 'Steam' : 'Epic'}: seeded config channel ${channelId} for guild ${guildId}.`,
  );
}

/** One post target per guild the bot can actually send to. */
export async function resolveDealTargets(
  client: Client,
  settingsStore: GuildSettingsStore,
  config: Config,
  logger: Logger,
  kind: DealKind,
): Promise<DealTarget[]> {
  await seedLegacyChannel(
    client,
    settingsStore,
    kind === 'steam' ? config.steam.channelId : config.epic.channelId,
    kind,
    logger,
  );

  await client.guilds.fetch().catch(() => null);
  const targets: DealTarget[] = [];

  for (const guild of client.guilds.cache.values()) {
    const settings = await settingsStore.get(guild.id);
    const enabled = kind === 'steam' ? settings.steamEnabled : settings.epicEnabled;
    if (!enabled) continue;

    const configuredId = kind === 'steam' ? settings.steamChannelId : settings.epicChannelId;
    let channel: SendableChannels | null = null;

    if (configuredId) {
      channel = await resolveGuildSendableChannel(client, configuredId, guild.id);
      if (!channel) {
        logger.warn(
          `${kind}: configured channel ${configuredId} missing in ${guild.name} (${guild.id}).`,
        );
      }
    }

    if (!channel) {
      channel = await findChannelByName(guild, kind);
      if (channel) {
        await settingsStore.upsert(guild.id, {
          ...(kind === 'steam'
            ? { steamChannelId: channel.id, steamEnabled: true }
            : { epicChannelId: channel.id, epicEnabled: true }),
        });
        logger.info(
          `${kind}: auto-wired #${'name' in channel ? channel.name : channel.id} in ${guild.name}.`,
        );
      }
    }

    if (!channel) continue;

    targets.push({
      guildId: guild.id,
      guildName: guild.name,
      channel,
      settings: await settingsStore.get(guild.id),
    });
  }

  return targets;
}
