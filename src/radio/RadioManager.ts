import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../core/logger';
import { RadioSession } from './RadioSession';
import { RADIO_KISS_NAME } from './station';

const JOIN_TIMEOUT_MS = 20_000;

/** Tracks one Radio Kiss session per guild. */
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
   * Join `channel` and start Radio Kiss. Reuses a healthy same-channel session.
   * Replaces a dead session or one in a different channel.
   */
  async play(channel: VoiceBasedChannel): Promise<RadioSession> {
    const guildId = channel.guild.id;

    const existing = this.sessions.get(guildId);
    if (existing) {
      const status = existing.connection.state.status;
      const sameChannel = existing.channelId === channel.id;
      if (sameChannel && existing.isLive && status === VoiceConnectionStatus.Ready) {
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

    const session = new RadioSession(connection, this.logger, () => {
      this.sessions.delete(guildId);
    });
    this.sessions.set(guildId, session);
    session.start();
    try {
      await session.waitForStart();
    } catch (err) {
      this.logger.error(`${RADIO_KISS_NAME} failed to start in guild ${guildId}:`, err);
      throw err;
    }
    this.logger.info(
      `${RADIO_KISS_NAME} started in guild ${guildId} → #${channel.name} (${channel.id})`,
    );
    return session;
  }
}
