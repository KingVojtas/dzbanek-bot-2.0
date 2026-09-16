import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Message, SendableChannels } from 'discord.js';
import { buildTrackEmbed } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { LoopMode, Track, TrackSource } from '../core/types';

const HISTORY_MAX = 25;

/**
 * Owns the voice connection, audio player, and queue for a single guild.
 *
 * Advancing the queue is driven by the player's Idle event. When a new track
 * actually starts, the previous Now Playing embed is deleted and a fresh one
 * is posted so the channel never stacks NP messages.
 */
export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | null = null;
  loopMode: LoopMode = 'off';
  lastError: string | null = null;

  private history: Track[] = [];
  private nowPlayingMessage: Message | null = null;
  private announceChannel: SendableChannels | null = null;
  private announceSerial = 0;

  private readonly player: AudioPlayer;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private playGeneration = 0;
  private queuePumpRunning = false;
  private suppressIdleAdvance = false;
  /** When true, Idle must advance even if loop mode is `track`. */
  private skipRequested = false;
  private queueSnapshot: Track[] = [];

  constructor(
    readonly connection: VoiceConnection,
    private readonly source: TrackSource,
    private readonly logger: Logger,
    private readonly idleTimeoutSec: number,
    private readonly onDestroy: () => void,
  ) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.suppressIdleAdvance) {
        this.suppressIdleAdvance = false;
        return;
      }
      const finished = this.current;
      this.current = null;

      if (finished) {
        if (this.loopMode === 'track' && !this.skipRequested) {
          this.queue.unshift(finished);
        } else {
          this.pushHistory(finished);
        }
      }
      this.skipRequested = false;

      void this.processQueue();
    });

    this.player.on('error', (error) => {
      this.logger.error('Audio player error:', error);
      this.current = null;
      void this.processQueue();
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect();
    });
  }

  setAnnounceChannel(channel: SendableChannels | null): void {
    this.announceChannel = channel;
  }

  getNowPlayingMessage(): Message | null {
    return this.nowPlayingMessage;
  }

  /**
   * Delete the previous Now Playing embed and post a fresh one for `track`.
   * Called on every successful playTrack so the chat stays to a single NP message.
   */
  async publishFreshNowPlaying(track: Track): Promise<void> {
    if (this.destroyed) return;

    const channel = this.announceChannel;
    if (!channel) return;

    const serial = ++this.announceSerial;
    const old = this.nowPlayingMessage;
    this.nowPlayingMessage = null;

    if (old) {
      try {
        await old.delete();
      } catch {
        /* already deleted / missing access */
      }
    }

    if (this.destroyed || serial !== this.announceSerial) return;

    try {
      const msg = await channel.send({
        embeds: [buildTrackEmbed(track, 'Now Playing')],
      });
      if (this.destroyed || serial !== this.announceSerial) {
        try {
          await msg.delete();
        } catch {
          /* ignore */
        }
        return;
      }
      this.nowPlayingMessage = msg;
    } catch (err) {
      this.logger.debug('Failed to post now-playing message:', err);
    }
  }

  enqueue(tracks: Track[]): void {
    this.lastError = null;
    this.queue.push(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
  }

  enqueueNext(tracks: Track[]): void {
    this.lastError = null;
    this.queue.unshift(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
  }

  skip(): Track | null {
    this.skipRequested = true;
    this.player.stop(true);
    return this.queue[0] ?? null;
  }

  previous(): boolean {
    const prev = this.history.pop();
    const cur = this.current;

    if (prev) {
      this.current = null;
      if (cur) this.queue.unshift(cur);
      this.queue.unshift(prev);
      this.suppressIdleAdvance = true;
      this.player.stop(true);
      void this.processQueue();
      return true;
    }

    if (cur) {
      this.current = null;
      this.queue.unshift(cur);
      this.suppressIdleAdvance = true;
      this.player.stop(true);
      void this.processQueue();
      return true;
    }
    return false;
  }

  stop(): void {
    this.queue.length = 0;
    this.queueSnapshot = [];
    this.history = [];
    this.loopMode = 'off';
    this.player.stop(true);
    void this.deleteNowPlaying();
    this.destroy();
  }

  pause(): boolean {
    if (!this.current) return false;
    const ok = this.player.pause();
    if (ok) this.clearIdleTimer();
    return ok;
  }

  resume(): boolean {
    if (!this.current) return false;
    return this.player.unpause();
  }

  get paused(): boolean {
    return this.player.state.status === 'paused';
  }

  shuffle(): number {
    if (this.queue.length < 2) return 0;

    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = this.queue[i]!;
      const b = this.queue[j]!;
      this.queue[i] = b;
      this.queue[j] = a;
    }

    if (this.loopMode === 'queue') {
      this.queueSnapshot = [...this.queue];
    }
    return this.queue.length;
  }

  remove(index: number): Track | null {
    if (index < 0 || index >= this.queue.length) return null;
    return this.queue.splice(index, 1)[0] ?? null;
  }

  setLoopMode(mode: LoopMode): void {
    this.loopMode = mode;
    if (mode === 'queue' && this.queue.length > 0) {
      this.queueSnapshot = [...this.queue];
    } else if (mode !== 'queue') {
      this.queueSnapshot = [];
    }
  }

  async waitForPlaybackAttempt(timeoutMs = 25_000): Promise<{ ok: boolean; error: string | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.current) return { ok: true, error: null };
      if (this.lastError && !this.queuePumpRunning && !this.current && this.queue.length === 0) {
        return { ok: false, error: this.lastError };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.current) return { ok: true, error: null };
    return { ok: false, error: this.lastError ?? 'Timed out waiting for audio to start.' };
  }

  private async processQueue(): Promise<void> {
    if (this.destroyed) return;
    if (this.queuePumpRunning) return;
    this.queuePumpRunning = true;

    try {
      while (!this.destroyed) {
        let next = this.queue.shift();
        if (!next) {
          if (this.loopMode === 'queue' && this.queueSnapshot.length > 0) {
            this.queue.push(...this.queueSnapshot);
            next = this.queue.shift();
          }
          if (!next) {
            this.startIdleTimer();
            return;
          }
        }

        const playing = await this.playTrack(next);
        if (playing) return;
      }
    } finally {
      this.queuePumpRunning = false;
    }
  }

  private async playTrack(track: Track): Promise<boolean> {
    if (this.destroyed) return false;
    const gen = ++this.playGeneration;
    this.lastError = null;

    try {
      this.logger.info(`Starting stream for: ${track.title} (${track.url})`);
      const stream = await this.source.stream(track);
      if (this.destroyed || gen !== this.playGeneration) return false;

      const probed = await demuxProbe(stream);
      if (this.destroyed || gen !== this.playGeneration) return false;

      const resource = createAudioResource(probed.stream, {
        inputType: probed.type,
        inlineVolume: true,
      });
      this.current = track;
      this.player.play(resource);
      this.logger.info(`Audio player started: ${track.title} (${this.queue.length} still queued)`);

      void this.publishFreshNowPlaying(track).catch((err: unknown) =>
        this.logger.debug('publishFreshNowPlaying failed:', err),
      );
      return true;
    } catch (error) {
      const lastMsg = error instanceof Error ? error.message : String(error);
      this.lastError = lastMsg;
      this.current = null;
      this.logger.error(`Failed to play "${track.title}":`, error);
      this.logger.warn(`Skipping unplayable track "${track.title}" — continuing queue`);
      return false;
    }
  }

  private pushHistory(track: Track): void {
    this.history.push(track);
    if (this.history.length > HISTORY_MAX) {
      this.history.splice(0, this.history.length - HISTORY_MAX);
    }
  }

  private async deleteNowPlaying(): Promise<void> {
    const old = this.nowPlayingMessage;
    this.nowPlayingMessage = null;
    this.announceSerial += 1;
    if (!old) return;
    try {
      await old.delete();
    } catch {
      /* ignore */
    }
  }

  private async handleDisconnect(): Promise<void> {
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      void this.deleteNowPlaying();
      this.destroy();
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.deleteNowPlaying();
      this.destroy();
    }, this.idleTimeoutSec * 1000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdleTimer();
    this.nowPlayingMessage = null;
    this.announceChannel = null;
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.onDestroy();
  }
}
