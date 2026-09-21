import { ActivityType, type Client } from 'discord.js';
import type { Logger } from '../core/logger';
import type { MusicManager } from '../music/MusicManager';
import type { RadioManager } from '../radio/RadioManager';

const TICK_MS = 15_000;
const NAME_MAX = 128;

export interface PresenceKitchen {
  steamHeadline(): string | null;
}

interface StereoPick {
  type: ActivityType;
  name: string;
}

/** Global bot status follows the loudest kitchen stereo (one activity per shard). */
export class StereoPresence {
  private lastKey = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Client,
    private readonly music: MusicManager,
    private readonly radio: RadioManager,
    private readonly kitchen: PresenceKitchen,
    private readonly logger: Logger,
  ) {}

  attach(): void {
    this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  tick(): void {
    const user = this.client.user;
    if (!user) return;
    const pick = this.pick();
    const key = `${pick.type}:${pick.name}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      user.setPresence({
        status: 'online',
        activities: [{ name: pick.name, type: pick.type }],
      });
    } catch (error) {
      this.logger.debug('Presence update failed:', error);
    }
  }

  private pick(): StereoPick {
    let best: { score: number; pick: StereoPick } | null = null;

    for (const guild of this.client.guilds.cache.values()) {
      const radio = this.radio.get(guild.id);
      if (radio && this.radio.isPlaying(guild.id)) {
        const station = radio.station;
        const track = radio.nowPlaying;
        const title = track?.title?.trim();
        const name =
          title && title.toLowerCase() !== station.name.toLowerCase()
            ? `${title} · ${station.name}`
            : station.name;
        const listeners = this.listenerCount(guild.id, radio.channelId);
        const pick = { type: ActivityType.Listening, name: clip(name) };
        if (!best || listeners >= best.score) best = { score: 1000 + listeners, pick };
        continue;
      }

      const player = this.music.get(guild.id);
      const track = player?.current;
      if (player && track) {
        const listeners = this.listenerCount(guild.id, player.connection.joinConfig.channelId);
        const pick = { type: ActivityType.Listening, name: clip(track.title) };
        if (!best || listeners > best.score) best = { score: 500 + listeners, pick };
      }
    }

    if (best) return best.pick;

    const steal = this.kitchen.steamHeadline();
    if (steal) return { type: ActivityType.Playing, name: clip(steal) };
    return { type: ActivityType.Watching, name: 'the kitchen' };
  }

  private listenerCount(guildId: string, channelId: string | null): number {
    if (!channelId) return 0;
    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) return 0;
    return [...channel.members.values()].filter((member) => !member.user.bot).length;
  }
}

function clip(name: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim() || 'the kitchen';
  return trimmed.length <= NAME_MAX ? trimmed : `${trimmed.slice(0, NAME_MAX - 1)}…`;
}
