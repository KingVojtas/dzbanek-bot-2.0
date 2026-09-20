import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { update as updateYoutubeDl } from 'youtube-dl-exec';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { TrackSource } from '../core/types';
import { GuildPlayer } from './GuildPlayer';
import { CompositeTrackSource } from './sources';
import { ensureYtDlpCookies } from './ytdlp-cookies';

const JOIN_TIMEOUT_MS = 20_000;

/** Tracks one music player per guild and creates voice connections on demand. */
export class MusicManager {
  private readonly subscriptions = new Map<string, GuildPlayer>();
  private readonly source: TrackSource = new CompositeTrackSource();
  private preemptRadio: ((guildId: string) => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    ensureYtDlpCookies(this.logger);

    void updateYoutubeDl()
      .then(() => this.logger.debug('yt-dlp self-update check complete.'))
      .catch((err: unknown) => this.logger.debug('yt-dlp update check (non-fatal):', err));
  }

  get trackSource(): TrackSource {
    return this.source;
  }

  /** Stop radio in this guild before music takes the voice connection. */
  setPreempt(fn: (guildId: string) => void): void {
    this.preemptRadio = fn;
  }

  get(guildId: string): GuildPlayer | undefined {
    return this.subscriptions.get(guildId);
  }

  /** Join `channel` (or return the existing healthy player for the guild). */
  async join(channel: VoiceBasedChannel): Promise<GuildPlayer> {
    const guildId = channel.guild.id;
    this.preemptRadio?.(guildId);

    const existing = this.subscriptions.get(guildId);
    if (existing) {
      const status = existing.connection.state.status;
      const sameChannel = existing.connection.joinConfig.channelId === channel.id;
      if (sameChannel && status === VoiceConnectionStatus.Ready) {
        return existing;
      }
      this.logger.warn(
        `Replacing voice subscription for ${guildId} (status=${status}, sameChannel=${sameChannel})`,
      );
      try {
        existing.stop();
      } catch {
        /* ignore */
      }
      this.subscriptions.delete(guildId);
      try {
        getVoiceConnection(guildId)?.destroy();
      } catch {
        /* ignore */
      }
    } else {
      try {
        getVoiceConnection(guildId)?.destroy();
      } catch {
        /* ignore */
      }
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.attachVoiceDebug(guildId, connection);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch (err) {
      const status = connection.state.status;
      this.logger.error(
        `Voice join failed for guild ${guildId} channel ${channel.id} (status=${status}):`,
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
          'the channel is not full, and try `/play` again. ' +
          `(voice status: ${status})`,
        { cause: err },
      );
    }

    const player = new GuildPlayer(
      connection,
      this.source,
      this.logger,
      this.config.music.idleTimeoutSec,
      () => this.subscriptions.delete(guildId),
    );
    this.subscriptions.set(guildId, player);
    this.logger.info(`Voice ready in guild ${guildId} → #${channel.name} (${channel.id})`);
    return player;
  }

  private attachVoiceDebug(guildId: string, connection: VoiceConnection): void {
    connection.on('stateChange', (oldState, newState) => {
      this.logger.info(`Voice ${guildId}: ${oldState.status} → ${newState.status}`);
    });
    connection.on('error', (error) => {
      this.logger.error(`Voice connection error ${guildId}:`, error);
    });
  }
}
