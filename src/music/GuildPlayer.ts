import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, AudioResource, VoiceConnection } from '@discordjs/voice';
import { PassThrough, type Readable } from 'node:stream';
import { DiscordAPIError, type Message, type SendableChannels } from 'discord.js';
import { buildNowPlayingDisplay, type V2Display } from '../core/display';
import type { Logger } from '../core/logger';
import type { LoopMode, Track, TrackSource } from '../core/types';

const HISTORY_MAX = 25;
const PROGRESS_TICK_MS = 1000;

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
  /** When true, Idle must advance even if loop mode is `track`. */
  private skipRequested = false;
  private queueSnapshot: Track[] = [];
  private currentResource: AudioResource | null = null;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressSec = -1;
  private progressEditInFlight = false;
  private progressBackoffUntil = 0;
  private prefetched: { url: string; stream: Readable } | null = null;
  private lastSkipAt = 0;
  private idleAdvanceScheduled = false;

  constructor(
    readonly connection: VoiceConnection,
    private readonly source: TrackSource,
    private readonly logger: Logger,
    private readonly idleTimeoutSec: number,
    private readonly onDestroy: () => void,
  ) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status !== AudioPlayerStatus.Idle) return;
      if (oldState.status === AudioPlayerStatus.Idle) return;

      const finishedResource = 'resource' in oldState ? oldState.resource : undefined;
      if (
        finishedResource &&
        this.currentResource &&
        finishedResource !== this.currentResource
      ) {
        return;
      }

      if (this.idleAdvanceScheduled) return;
      this.idleAdvanceScheduled = true;
      setImmediate(() => {
        this.idleAdvanceScheduled = false;
        this.onPlayerBecameIdle();
      });
    });

    this.player.on('error', (error) => {
      this.logger.error('Audio player error:', error);
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect();
    });
  }

  setAnnounceChannel(channel: SendableChannels | null): void {
    this.announceChannel = channel;
  }

  getPlaybackPositionSec(): number {
    const ms = this.currentResource?.playbackDuration;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 0;
    return ms / 1000;
  }

  buildNowPlayingPanel(track: Track = this.current!): V2Display {
    const raw = this.getPlaybackPositionSec();
    const positionSec =
      track.durationSec > 0 ? Math.min(raw, track.durationSec) : raw;
    return buildNowPlayingDisplay({
      track,
      queueLength: this.queue.length,
      paused: this.paused,
      loopMode: this.loopMode,
      positionSec,
      upNextTitle: this.queue.find((track) => track !== this.current)?.title ?? null,
      label: this.paused ? 'Paused' : 'Now Playing',
    });
  }

  async refreshNowPlaying(): Promise<void> {
    const msg = this.nowPlayingMessage;
    const track = this.current;
    if (!msg || !track || this.destroyed) return;
    const display = this.buildNowPlayingPanel(track);
    try {
      await msg.edit({
        components: display.components,
        flags: display.flags,
      });
    } catch (error) {
      if (isUnknownMessage(error)) {
        this.nowPlayingMessage = null;
        this.stopProgressTicker();
      }
    }
  }

  cycleLoopMode(): LoopMode {
    const next: LoopMode =
      this.loopMode === 'off' ? 'track' : this.loopMode === 'track' ? 'queue' : 'off';
    this.setLoopMode(next);
    return next;
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
      const display = this.buildNowPlayingPanel(track);
      const msg = await channel.send({
        components: display.components,
        flags: display.flags,
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
      this.startProgressTicker();
    } catch (err) {
      this.logger.debug('Failed to post now-playing message:', err);
    }
  }

  enqueue(tracks: Track[]): void {
    this.lastError = null;
    const wasEmpty = this.queue.length === 0;
    this.queue.push(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
    else if (wasEmpty) this.prefetchNext();
  }

  enqueueNext(tracks: Track[]): void {
    this.lastError = null;
    this.queue.unshift(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
    else {
      this.invalidatePrefetch();
      this.prefetchNext();
    }
  }

  skip(): Track | null {
    const now = Date.now();
    const next = this.queue.find((track) => track !== this.current) ?? this.queue[0] ?? null;
    if (now - this.lastSkipAt < 1000) {
      return next;
    }
    if (this.queuePumpRunning) {
      return next;
    }
    this.lastSkipAt = now;
    this.skipRequested = true;
    this.player.stop(true);
    return next;
  }

  stop(): void {
    this.queue.length = 0;
    this.queueSnapshot = [];
    this.history = [];
    this.loopMode = 'off';
    this.invalidatePrefetch();
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
    this.invalidatePrefetch();
    this.prefetchNext();
    return this.queue.length;
  }

  remove(index: number): Track | null {
    if (index < 0 || index >= this.queue.length) return null;
    const removed = this.queue.splice(index, 1)[0] ?? null;
    if (index === 0) {
      this.invalidatePrefetch();
      this.prefetchNext();
    }
    return removed;
  }

  setLoopMode(mode: LoopMode): void {
    this.loopMode = mode;
    if (mode === 'queue' && this.queue.length > 0) {
      this.queueSnapshot = [...this.queue];
    } else if (mode !== 'queue') {
      this.queueSnapshot = [];
    }
  }

  async waitForPlaybackAttempt(timeoutMs = 20_000): Promise<{ ok: boolean; error: string | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = this.player.state.status;
      if (
        status === AudioPlayerStatus.Playing ||
        status === AudioPlayerStatus.Paused ||
        status === AudioPlayerStatus.Buffering
      ) {
        return { ok: true, error: null };
      }
      if (this.lastError && !this.queuePumpRunning && !this.currentResource) {
        return { ok: false, error: this.lastError };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const status = this.player.state.status;
    if (
      status === AudioPlayerStatus.Playing ||
      status === AudioPlayerStatus.Paused ||
      status === AudioPlayerStatus.Buffering
    ) {
      return { ok: true, error: null };
    }
    return { ok: false, error: this.lastError ?? 'Timed out waiting for audio to start.' };
  }

  private onPlayerBecameIdle(): void {
    if (this.destroyed) return;
    if (this.queuePumpRunning) return;
    if (this.player.state.status !== AudioPlayerStatus.Idle) return;

    const playedMs = this.currentResource?.playbackDuration ?? 0;
    const finished = this.current;

    if (finished && playedMs < 800 && !this.skipRequested) {
      this.invalidatePrefetch();
      this.currentResource = null;
      this.queue.unshift(finished);
      this.current = null;
      this.logger.warn(`Track "${finished.title}" ended immediately — retrying with a fresh stream.`);
      void this.processQueue();
      return;
    }

    this.current = null;
    this.currentResource = null;

    if (finished) {
      if (this.loopMode === 'track' && !this.skipRequested) {
        this.queue.unshift(finished);
      } else {
        this.pushHistory(finished);
      }
    }
    this.skipRequested = false;

    void this.processQueue();
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
    this.current = track;

    try {
      this.logger.info(`Starting stream for: ${track.title} (${track.url})`);
      const stream = await this.openStream(track, gen);
      if (!stream) return false;

      const probed = await demuxProbe(stream);
      if (this.destroyed || gen !== this.playGeneration) return false;

      const resource = createAudioResource(probed.stream, {
        inputType: probed.type,
        inlineVolume: true,
      });
      this.current = track;
      this.currentResource = resource;
      this.player.play(resource);
      this.logger.info(`Audio player started: ${track.title} (${this.queue.length} still queued)`);

      void this.publishFreshNowPlaying(track).catch((err: unknown) =>
        this.logger.debug('publishFreshNowPlaying failed:', err),
      );
      this.prefetchNext();
      return true;
    } catch (error) {
      const lastMsg = error instanceof Error ? error.message : String(error);
      this.lastError = lastMsg;
      this.current = null;
      this.currentResource = null;
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

  private streamUsable(stream: Readable): boolean {
    return !stream.destroyed && !stream.readableEnded && stream.readable;
  }

  private async openStream(track: Track, gen: number): Promise<Readable | null> {
    const prefetched =
      this.prefetched && this.prefetched.url === track.url ? this.prefetched.stream : null;
    this.prefetched = null;

    if (prefetched && this.streamUsable(prefetched)) {
      return prefetched;
    }
    if (prefetched) {
      try {
        prefetched.destroy();
      } catch {
        /* ignore */
      }
    }

    const fresh = await this.source.stream(track);
    if (this.destroyed || gen !== this.playGeneration) {
      fresh.destroy();
      return null;
    }
    return fresh;
  }

  private invalidatePrefetch(): void {
    if (!this.prefetched) return;
    try {
      this.prefetched.stream.destroy();
    } catch {
      /* ignore */
    }
    this.prefetched = null;
  }

  private prefetchNext(): void {
    const next = this.queue.find((track) => track !== this.current);
    if (!next || this.destroyed) return;
    if (this.prefetched?.url === next.url) return;
    this.invalidatePrefetch();
    const url = next.url;
    const gen = this.playGeneration;
    void this.source
      .stream(next)
      .then((raw) => {
        if (this.destroyed || gen !== this.playGeneration) {
          raw.destroy();
          return;
        }
        const queued = this.queue.find((track) => track !== this.current);
        if (!queued || queued.url !== url) {
          raw.destroy();
          return;
        }
        const buffered = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
        raw.pipe(buffered);
        this.prefetched = { url, stream: buffered };
      })
      .catch(() => {
        /* miss is fine — playTrack will stream on demand */
      });
  }

  private startProgressTicker(): void {
    this.stopProgressTicker();
    this.lastProgressSec = -1;
    this.progressTimer = setInterval(() => {
      void this.tickProgress();
    }, PROGRESS_TICK_MS);
    this.progressTimer.unref?.();
  }

  private stopProgressTicker(): void {
    if (!this.progressTimer) return;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  private async tickProgress(): Promise<void> {
    if (this.destroyed || !this.current || !this.nowPlayingMessage) {
      this.stopProgressTicker();
      return;
    }
    if (this.paused || this.progressEditInFlight) return;
    if (Date.now() < this.progressBackoffUntil) return;

    const pos = Math.floor(this.getPlaybackPositionSec());
    if (pos === this.lastProgressSec) return;
    this.lastProgressSec = pos;
    this.progressEditInFlight = true;

    try {
      await this.refreshNowPlaying();
    } catch (error) {
      const retry = retryAfterMs(error);
      if (retry != null) {
        this.progressBackoffUntil = Date.now() + retry;
        this.lastProgressSec = -1;
      }
    } finally {
      this.progressEditInFlight = false;
    }
  }

  private async deleteNowPlaying(): Promise<void> {
    this.stopProgressTicker();
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
    this.stopProgressTicker();
    this.invalidatePrefetch();
    this.nowPlayingMessage = null;
    this.announceChannel = null;
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.onDestroy();
  }
}

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && Number(error.code) === 10008;
}

function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000);
  }
  return null;
}
