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
import type { Track } from '../core/types';
import { GuildPlayer } from './GuildPlayer';
import { CompositeTrackSource } from './sources';
import { YouTubeHealth, type YouTubeAlert } from './youtube-health';
import { ensureYtDlpCookies } from './ytdlp-cookies';

const JOIN_TIMEOUT_MS = 20_000;

/** Tracks one music player per guild and creates voice connections on demand. */
export class MusicManager {
  private readonly subscriptions = new Map<string, GuildPlayer>();
  private readonly pendingJoins = new Map<string, Promise<GuildPlayer>>();
  private readonly source = new CompositeTrackSource();
  private preemptRadio: ((guildId: string) => void) | null = null;
  private onQueueIdle: ((guildId: string, channelId: string) => void) | null = null;
  private onTrackStart: ((guildId: string, track: Track) => void) | null = null;
  private fireCounts: ((guildId: string, track: Track) => Promise<number>) | null = null;

  private readonly youtubeHealth: YouTubeHealth;
  private readonly firstUpdate: Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    ensureYtDlpCookies(this.logger);
    this.firstUpdate = this.updateYtDlp();
    this.youtubeHealth = new YouTubeHealth(() => this.source.youtube.probe(), this.logger);
    this.source.youtube.onYouTube = (ok) => {
      if (ok) void this.youtubeHealth.working();
      else this.youtubeHealth.suspect();
    };
  }

  /** Who hears that YouTube's sign-in ran out, and that it works again. */
  setYouTubeAlert(fn: YouTubeAlert): void {
    this.youtubeHealth.setAlert(fn);
  }

  /** Probe YouTube once the startup yt-dlp update is through. */
  async checkYouTube(): Promise<void> {
    await this.firstUpdate;
    await this.youtubeHealth.check();
  }

  /**
   * YouTube breaks yt-dlp often, and the bot runs for weeks between deploys,
   * so this runs at startup and again every day. Safe while a song streams.
   */
  async updateYtDlp(): Promise<void> {
    try {
      await updateYoutubeDl();
      this.logger.info('yt-dlp update check complete.');
    } catch (error) {
      this.logger.warn('yt-dlp update failed; songs keep using the current version:', error);
    }
  }

  get trackSource(): CompositeTrackSource {
    return this.source;
  }

  /** Stop radio in this guild before music takes the voice connection. */
  setPreempt(fn: (guildId: string) => void): void {
    this.preemptRadio = fn;
  }

  /** After the idle timeout on an empty queue, optionally start radio in that channel. */
  setIdleHandoff(fn: (guildId: string, channelId: string) => void): void {
    this.onQueueIdle = fn;
  }

  /** Every track that starts playing, e.g. for the Kitchen Quiz song pool. */
  setOnTrackStart(fn: (guildId: string, track: Track) => void): void {
    this.onTrackStart = fn;
  }

  /** 🔥 on the song that just went on the card. Read when the player builds it. */
  setFireCounts(fn: (guildId: string, track: Track) => Promise<number>): void {
    this.fireCounts = fn;
  }

  get(guildId: string): GuildPlayer | undefined {
    return this.subscriptions.get(guildId);
  }

  /** Stop every player and leave voice (shutdown). */
  stopAll(): void {
    for (const player of [...this.subscriptions.values()]) {
      try {
        player.stop();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Join `channel` (or return the existing healthy player for the guild).
   * Joins for one guild run one at a time, so a double-click cannot build two players.
   */
  async join(channel: VoiceBasedChannel): Promise<GuildPlayer> {
    const guildId = channel.guild.id;
    const previous = this.pendingJoins.get(guildId);
    const attempt = (async () => {
      if (previous) await previous.catch(() => {});
      return this.joinNow(channel);
    })();
    this.pendingJoins.set(guildId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.pendingJoins.get(guildId) === attempt) this.pendingJoins.delete(guildId);
    }
  }

  private async joinNow(channel: VoiceBasedChannel): Promise<GuildPlayer> {
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
      (idleGuildId, idleChannelId) => this.onQueueIdle?.(idleGuildId, idleChannelId),
      (track) => this.onTrackStart?.(guildId, track),
    );
    player.setFireCountLoader((track) => this.fireCounts?.(guildId, track) ?? Promise.resolve(0));
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
