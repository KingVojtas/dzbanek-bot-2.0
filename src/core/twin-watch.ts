import { GatewayDispatchEvents, type Client } from 'discord.js';
import type { Logger } from './logger';

/** One DM per guild per hour. The copies keep fighting the whole time. */
const WARN_EVERY_MS = 60 * 60_000;

/**
 * True when `packet` is this bot sitting in a voice channel on a gateway
 * session other than ours. A leave, our own session, or a packet from before
 * READY is not a second copy.
 */
export function isTwinSession(
  packet: unknown,
  botId: string,
  ourSessionId: string | null,
): boolean {
  if (!ourSessionId) return false;
  if (!packet || typeof packet !== 'object') return false;
  const data = packet as {
    user_id?: unknown;
    channel_id?: unknown;
    session_id?: unknown;
  };
  if (data.user_id !== botId) return false;
  if (typeof data.channel_id !== 'string' || !data.channel_id) return false;
  if (typeof data.session_id !== 'string' || !data.session_id) return false;
  return data.session_id !== ourSessionId;
}

/**
 * Watch raw gateway voice states for another session of this bot in voice.
 * READY refreshes our session id, including after a new identify. The owner
 * is told at most once an hour per guild.
 */
export function watchForTwin(
  client: Client,
  logger: Logger,
  dm: (text: string) => Promise<void>,
  now: () => number = Date.now,
): void {
  let ourSessionId: string | null = null;
  let botId: string | null = null;
  const warnedAt = new Map<string, number>();

  client.ws.on(
    GatewayDispatchEvents.Ready,
    (data: { session_id?: unknown; user?: { id?: unknown } }) => {
      if (typeof data?.session_id === 'string' && data.session_id) ourSessionId = data.session_id;
      if (typeof data?.user?.id === 'string' && data.user.id) botId = data.user.id;
    },
  );

  client.ws.on(GatewayDispatchEvents.VoiceStateUpdate, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const packet = data as {
      user_id?: unknown;
      channel_id?: unknown;
      session_id?: unknown;
      guild_id?: unknown;
    };
    const self = client.user?.id ?? botId;
    if (!self || packet.user_id !== self) return;
    logger.debug(
      `Own voice state: session ${String(packet.session_id)} (ours ${ourSessionId ?? 'unknown'}).`,
    );
    if (!isTwinSession(packet, self, ourSessionId)) return;

    const channelId = typeof packet.channel_id === 'string' ? packet.channel_id : '';
    const guildId = typeof packet.guild_id === 'string' ? packet.guild_id : '';
    const guild = guildId ? client.guilds.cache.get(guildId) : undefined;
    const channel = channelId
      ? (guild?.channels.cache.get(channelId) ?? client.channels.cache.get(channelId))
      : undefined;
    const rawName = channel && 'name' in channel ? channel.name : null;
    const guildName = guild?.name || guildId || 'unknown server';
    const channelName = typeof rawName === 'string' && rawName ? rawName : channelId;
    const session = typeof packet.session_id === 'string' ? packet.session_id : 'unknown';

    logger.warn(
      `Another copy of this bot (gateway session ${session}) is in voice in ${guildName} #${channelName}. Two copies fight over the speaker.`,
    );

    const key = guildId || channelId || 'unknown';
    const at = now();
    const previous = warnedAt.get(key);
    if (previous !== undefined && at - previous < WARN_EVERY_MS) return;
    warnedAt.set(key, at);
    void dm(
      `⚠️ Another copy of Dzbanek-bot is running with the same token and just joined voice in ${guildName} (#${channelName}). Songs jump between the two copies until one is stopped.`,
    );
  });
}
