import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, AudioResource, VoiceConnection } from '@discordjs/voice';
import type { Readable } from 'node:stream';
import type { Message, SendableChannels } from 'discord.js';
import { bufferStream } from './buffer-stream';
import { isUnknownMessage } from '../core/discord-errors';
import { buildNowPlayingDisplay } from '../core/display';
import { upcomingQueue, type EmbedCard } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { LoopMode, Track, TrackSource } from '../core/types';
import { afterTrackEnds, pushHistory, takeNext } from './queue-rules';

const VOLUME_MIN = 0.25;
const VOLUME_MAX = 1.5;
const VOLUME_STEP = 0.25;
/** Discord allows about 5 edits per 5 s per channel; leave room for buttons and the board. */
const PROGRESS_TICK_MS = 5_000;

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
  /** URL already retried once after ending instantly. */
  private retriedUrl: string | null = null;
  /** Set by previous(): the finished track is already back in the queue. */
  private goingBack = false;
  private volume = 1;

  constructor(
    readonly connection: VoiceConnection,
    private readonly source: TrackSource,
    private readonly logger: Logger,
    private readonly idleTimeoutSec: number,
    private readonly onDestroy: () => void,
    private readonly onQueueIdle: ((guildId: string, channelId: string) => void) | null = null,
    private readonly onTrackStart: ((track: Track) => void) | null = null,
  ) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status !== AudioPlayerStatus.Idle) return;
      if (oldState.status === AudioPlayerStatus.Idle) return;

      const finishedResource = 'resource' in oldState ? oldState.resource : undefined;
      if (finishedResource && this.currentResource && finishedResource !== this.currentResource) {
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

  buildNowPlayingPanel(track: Track = this.current!): EmbedCard {
    const raw = this.getPlaybackPositionSec();
    const positionSec = track.durationSec > 0 ? Math.min(raw, track.durationSec) : raw;
    const upcoming = upcomingQueue(this.current, this.queue);
    return buildNowPlayingDisplay({
      track,
      next: upcoming[0] ?? null,
      queueLength: upcoming.length,
      paused: this.paused,
      loopMode: this.loopMode,
      positionSec,
      volume: this.volume,
      hasHistory: this.history.length > 0,
    });
  }

  /** Move the Now Playing card to the bottom of `channel` (deletes the old one). */
  async repostNowPlaying(channel: SendableChannels): Promise<boolean> {
    const track = this.current;
    if (!track || this.destroyed) return false;
    this.announceChannel = channel;
    await this.publishFreshNowPlaying(track);
    return this.nowPlayingMessage !== null;
  }

  get hasHistory(): boolean {
    return this.history.length > 0;
  }

  /** Clamp to 25–150 % and apply to the playing track; later tracks inherit it. */
  setVolume(value: number): number {
    const clamped = Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(value * 100) / 100));
    this.volume = clamped;
    this.currentResource?.volume?.setVolume(clamped);
    return clamped;
  }

  /** Step the volume up (+1) or down (-1) by 25 %. */
  stepVolume(direction: 1 | -1): number {
    return this.setVolume(this.volume + direction * VOLUME_STEP);
  }

  /**
   * Go back one track: the last finished track plays again, and the current one
   * waits right behind it. False when there is no history or a track is loading.
   */
  previous(): boolean {
    if (this.queuePumpRunning) return false;
    const prev = this.history.pop();
    if (!prev) return false;
    if (this.current) this.queue.unshift(this.current);
    this.queue.unshift(prev);
    this.goingBack = true;
    this.skipRequested = true;
    this.invalidatePrefetch();
    this.player.stop(true);
    return true;
  }

  /** `rethrow` lets the progress ticker see rate limits and back off. */
  async refreshNowPlaying(rethrow = false): Promise<void> {
    const msg = this.nowPlayingMessage;
    const track = this.current;
    if (!msg || !track || this.destroyed) return;
    const display = this.buildNowPlayingPanel(track);
    try {
      await msg.edit({ embeds: display.embeds, components: display.components });
    } catch (error) {
      if (isUnknownMessage(error)) {
        this.nowPlayingMessage = null;
        this.stopProgressTicker();
      } else if (rethrow) {
        throw error;
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
      const msg = await channel.send({ embeds: display.embeds, components: display.components });
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

  /**
   * Insert right after `anchor`, or at the front once it has played. Keeps a
   * play-next playlist in order while it arrives in batches.
   */
  enqueueAfter(anchor: Track, tracks: Track[]): void {
    this.lastError = null;
    this.queue.splice(this.queue.indexOf(anchor) + 1, 0, ...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
    else this.prefetchNext();
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

    const finished = this.current;
    const next = afterTrackEnds({
      finished,
      playedMs: this.currentResource?.playbackDuration ?? 0,
      skipRequested: this.skipRequested,
      goingBack: this.goingBack,
      loopMode: this.loopMode,
      retriedUrl: this.retriedUrl,
    });

    if (finished && next === 'retry') {
      this.retriedUrl = finished.url;
      this.invalidatePrefetch();
      this.currentResource = null;
      this.queue.unshift(finished);
      this.current = null;
      this.logger.warn(
        `Track "${finished.title}" ended immediately — retrying with a fresh stream.`,
      );
      void this.processQueue();
      return;
    }

    if (finished && next === 'give-up') {
      // Second instant end in a row: the stream is broken, so move on instead of looping.
      this.lastError = `"${finished.title}" ended immediately twice.`;
      this.logger.warn(`Track "${finished.title}" ended immediately again — skipping it.`);
      this.retriedUrl = null;
      this.current = null;
      this.currentResource = null;
      pushHistory(this.history, finished);
      void this.processQueue();
      return;
    }
    this.retriedUrl = null;

    this.current = null;
    this.currentResource = null;

    if (finished && next === 'requeue') this.queue.unshift(finished);
    else if (finished && next === 'history') pushHistory(this.history, finished);
    this.skipRequested = false;
    this.goingBack = false;

    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.destroyed) return;
    if (this.queuePumpRunning) return;
    this.queuePumpRunning = true;

    try {
      while (!this.destroyed) {
        const next = takeNext(this.queue, this.loopMode, this.queueSnapshot);
        if (!next) {
          this.startIdleTimer();
          return;
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
      resource.volume?.setVolume(this.volume);
      this.current = track;
      this.currentResource = resource;
      this.player.play(resource);
      this.logger.info(`Audio player started: ${track.title} (${this.queue.length} still queued)`);
      this.onTrackStart?.(track);

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
        // Destroying the buffer (skip, shuffle) also ends yt-dlp.
        this.prefetched = { url, stream: bufferStream(raw) };
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
      await this.refreshNowPlaying(true);
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
      const guildId = this.connection.joinConfig.guildId;
      const channelId = this.connection.joinConfig.channelId;
      void this.deleteNowPlaying();
      const handoff = channelId ? this.onQueueIdle : null;
      this.destroy();
      if (handoff && channelId) handoff(guildId, channelId);
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

function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000);
  }
  return null;
}
