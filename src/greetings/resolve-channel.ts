import type { Client, Guild, SendableChannels } from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { GuildSettingsStore } from '../deals/guild-settings';
import { findChannelByNameHints, resolveGuildSendableChannel } from '../deals/targets';

export type GreetingKind = 'welcome' | 'goodbye';

const WELCOME_HINTS = ['welcome', 'welcomes', 'arrivals', 'hi', 'hello'];
const GOODBYE_HINTS = ['goodbye', 'goodbyes', 'farewell', 'leaves', 'departures'];

async function seedConfigChannel(
  client: Client,
  settingsStore: GuildSettingsStore,
  channelId: string | null,
  kind: GreetingKind,
  logger: Logger,
): Promise<void> {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || !('guildId' in channel) || !channel.guildId) return;
  if (!channel.isSendable()) return;

  const current = await settingsStore.get(channel.guildId);
  const field = kind === 'welcome' ? 'welcomeChannelId' : 'goodbyeChannelId';
  if (current[field]) return;

  await settingsStore.upsert(channel.guildId, {
    [field]: channelId,
    ...(kind === 'welcome' ? { welcomeEnabled: true } : { goodbyeEnabled: true }),
  });
  logger.info(`${kind}: seeded config channel ${channelId} for guild ${channel.guildId}.`);
}

export async function resolveGreetingChannel(
  client: Client,
  guild: Guild,
  settingsStore: GuildSettingsStore,
  config: Config,
  logger: Logger,
  kind: GreetingKind,
): Promise<SendableChannels | null> {
  await seedConfigChannel(
    client,
    settingsStore,
    kind === 'welcome' ? config.welcome.channelId : config.goodbye.channelId,
    kind,
    logger,
  );

  const settings = await settingsStore.get(guild.id);
  const enabled = kind === 'welcome' ? settings.welcomeEnabled : settings.goodbyeEnabled;
  if (!enabled) return null;

  const configuredId = kind === 'welcome' ? settings.welcomeChannelId : settings.goodbyeChannelId;
  if (configuredId) {
    const channel = await resolveGuildSendableChannel(client, configuredId, guild.id);
    if (channel) return channel;
    logger.warn(`${kind}: configured channel ${configuredId} missing in ${guild.name}.`);
  }

  const found = await findChannelByNameHints(
    guild,
    kind === 'welcome' ? WELCOME_HINTS : GOODBYE_HINTS,
  );
  if (found) {
    await settingsStore.upsert(guild.id, {
      ...(kind === 'welcome'
        ? { welcomeChannelId: found.id, welcomeEnabled: true }
        : { goodbyeChannelId: found.id, goodbyeEnabled: true }),
    });
    logger.info(
      `${kind}: auto-wired #${'name' in found ? found.name : found.id} in ${guild.name}.`,
    );
  }
  return found;
}
