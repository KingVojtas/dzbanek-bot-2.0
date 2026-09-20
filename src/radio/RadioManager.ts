import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../core/logger';
import { RadioSession } from './RadioSession';
import type { RadioStation } from './station';

const JOIN_TIMEOUT_MS = 20_000;

/** Tracks one live-radio session per guild. */
export class RadioManager {
  private readonly sessions = new Map<string, RadioSession>();

  constructor(private readonly logger: Logger) {}

  isPlaying(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  isLive(guildId: string): boolean {
    return this.sessions.get(guildId)?.isLive ?? false;
  }

  channelId(guildId: string): string | null {
    return this.sessions.get(guildId)?.channelId ?? null;
  }

  station(guildId: string): RadioStation | null {
    return this.sessions.get(guildId)?.station ?? null;
  }

  get(guildId: string): RadioSession | undefined {
    return this.sessions.get(guildId);
  }

  stop(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;
    try {
      session.destroy();
    } catch {
      /* ignore */
    }
    this.sessions.delete(guildId);
  }

  /**
   * Join `channel` and start `station`. Reuses a healthy same-channel session,
   * swapping the Icecast URL when the station changes. Replaces a dead session
   * or one in a different channel.
   */
  async play(channel: VoiceBasedChannel, station: RadioStation): Promise<RadioSession> {
    const guildId = channel.guild.id;

    const existing = this.sessions.get(guildId);
    if (existing) {
      const status = existing.connection.state.status;
      const sameChannel = existing.channelId === channel.id;
      if (sameChannel && existing.isLive && status === VoiceConnectionStatus.Ready) {
        if (existing.station.id === station.id) return existing;
        this.logger.info(
          `Switching radio in guild ${guildId}: ${existing.station.name} → ${station.name}`,
        );
        existing.switchStation(station);
        try {
          await existing.waitForStart();
          await existing.refreshNowPlaying();
        } catch (err) {
          this.logger.error(`${station.name} failed to start in guild ${guildId}:`, err);
          throw err;
        }
        return existing;
      }
      this.logger.warn(
        `Replacing radio session for ${guildId} (status=${status}, sameChannel=${sameChannel})`,
      );
      this.stop(guildId);
    }

    try {
      getVoiceConnection(guildId)?.destroy();
    } catch {
      /* ignore */
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch (err) {
      const status = connection.state.status;
      this.logger.error(
        `Radio voice join failed for guild ${guildId} channel ${channel.id} (status=${status}):`,
        err,
      );
      try {
        connection.destroy();
      } catch {
        /* ignore */
      }
      throw new Error(
        'Could not connect to the voice channel in time. ' +
          'Make sure the bot has **Connect** and **Speak** in that channel, ' +
          'the channel is not full, and try `/radio play` again. ' +
          `(voice status: ${status})`,
        { cause: err },
      );
    }

    const session = new RadioSession(connection, station, channel.name, this.logger, () => {
      this.sessions.delete(guildId);
    });
    this.sessions.set(guildId, session);
    session.start();
    try {
      await session.waitForStart();
      await session.refreshNowPlaying();
    } catch (err) {
      this.logger.error(`${station.name} failed to start in guild ${guildId}:`, err);
      throw err;
    }
    this.logger.info(
      `${station.name} started in guild ${guildId} → #${channel.name} (${channel.id})`,
    );
    return session;
  }
}
