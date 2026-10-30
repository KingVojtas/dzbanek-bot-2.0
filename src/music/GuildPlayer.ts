import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import type { AudioPlayer, AudioResource, VoiceConnection } from '@discordjs/voice';
import { Readable } from 'node:stream';
import type { Message, SendableChannels } from 'discord.js';
import { bufferStream } from './buffer-stream';
import { probeStream } from './probe-stream';
import { isUnknownMessage } from '../core/discord-errors';
import { buildNowPlayingDisplay } from '../core/display/music';
import { upcomingQueue, type EmbedCard } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { LoopMode, PlayerStation, StationIntro, Track, TrackSource } from '../core/types';
import { introPlayMs, pcmSeconds, streamOpenDelayMs } from './intro-wait';
import { afterTrackEnds, earlyEndWarning, pushHistory, takeNext } from './queue-rules';

const VOLUME_MIN = 0.25;
const VOLUME_MAX = 1.5;
const VOLUME_STEP = 0.25;
/** Discord allows about 5 edits per 5 s per channel; leave room for buttons and the board. */
const PROGRESS_TICK_MS = 5_000;
/** The next intro is written during the song before; an unprepared one gets this long. */
const INTRO_WAIT_MS = 12_000;
/** A break asks the player to wait this long for its clip to be ready. */
const LONG_INTRO_WAIT_MS = 60_000;
/** Station picks that fail in a row before the show stops trying (YouTube is down). */
const STATION_MISSES = 3;
/** Whole song, so yt-dlp exits and closes YouTube. Songs are 3–8 MB; a 12-minute cap stays under 16 MB. */
const PREFETCH_BYTES = 16 * 1024 * 1024;

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
  /**
   * The next song's audio, started while this one plays. `stream` is null until
   * yt-dlp sends bytes. `taken` means playTrack is waiting for it; `drop` means
   * skip, stop, or a newer prefetch threw it away.
   */
  private prefetched: {
    url: string;
    stream: Readable | null;
    ready: Promise<void>;
    drop: boolean;
    taken: boolean;
  } | null = null;
  private lastSkipAt = 0;
  private idleAdvanceScheduled = false;
  /** URL already retried once after ending instantly. */
  private retriedUrl: string | null = null;
  /** The current track's bytes came from the prefetch. */
  private currentPrefetched = false;
  /** Set by previous(): the finished track is already back in the queue. */
  private goingBack = false;
  private volume = 1;
  /** Kitchen FM, while it is on air. */
  private station: PlayerStation | null = null;
  /** What the DJ said before the current track. */
  private djLine: string | null = null;
  private introPlaying = false;
  /** The track that last started: the DJ's "that was…", and no intro for a repeat of it. */
  private lastStarted: Track | null = null;
  /** 🔥 on the song that is on. The card reads this; a press sets it before the lookup returns. */
  private fireCount = 0;
  private firesGeneration = 0;
  private firesTouched = false;
  private fireCountLoader: ((track: Track) => Promise<number>) | null = null;

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
      next: upcoming[0] ?? this.station?.queued() ?? null,
      queueLength: upcoming.length,
      paused: this.paused,
      loopMode: this.loopMode,
      positionSec,
      volume: this.volume,
      hasHistory: this.history.length > 0,
      dj: this.station
        ? { line: this.djLine, vibe: this.station.vibeOf(track), fires: this.fireCount }
        : undefined,
    });
  }

  /**
   * Put a station on air: it fills the gaps when the queue runs dry and talks
   * between songs. Requests in the queue still go first. Null takes it off.
   */
  setStation(station: PlayerStation | null): void {
    if (this.station === station || this.destroyed) return;
    this.station?.end();
    this.station = station;
    // A station pick is no longer next. A queued request's prefetch stays.
    const queuedNext = this.queue.find((track) => track !== this.current);
    if (!queuedNext || this.prefetched?.url !== queuedNext.url) this.invalidatePrefetch();
    if (!station) return;
    this.clearIdleTimer();
    // The song already on counts as just played, before the first set is planned.
    if (this.current) {
      station.heard?.(this.current);
      this.warmStation(this.current);
    } else void this.processQueue();
  }

  get onAir(): boolean {
    return this.station !== null;
  }

  /** How many 🔥 the card should show. Called when the song that is on changes hands. */
  setFireCountLoader(fn: (track: Track) => Promise<number>): void {
    this.fireCountLoader = fn;
  }

  /** A 🔥 press already knows the new count. A lookup for this song must not overwrite it. */
  noteFireCount(count: number): void {
    this.fireCount = Math.max(0, count);
    this.firesTouched = true;
  }

  /**
   * The lookup for the song that just started. False when a newer song started,
   * or someone already pressed 🔥, or the count is already on the card.
   */
  applyFireCount(generation: number, count: number): boolean {
    if (generation !== this.firesGeneration || this.firesTouched) return false;
    if (this.fireCount === count) return false;
    this.fireCount = Math.max(0, count);
    return true;
  }

  /** The DJ is speaking; Skip cuts the talk and starts the song. */
  get talking(): boolean {
    return this.introPlaying;
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
    else if (wasEmpty) {
      this.prefetchNext();
      this.warmStation(this.current);
    }
  }

  enqueueNext(tracks: Track[]): void {
    this.lastError = null;
    this.queue.unshift(...tracks);
    this.clearIdleTimer();
    if (!this.current) void this.processQueue();
    else {
      this.invalidatePrefetch();
      this.prefetchNext();
      this.warmStation(this.current);
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
    if (this.introPlaying) {
      this.player.stop(true);
      return this.current;
    }
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
      if (this.current && this.queue.length === 0) this.warmStation(this.current);
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
    const playedMs = this.currentResource?.playbackDuration ?? 0;
    const end = {
      finished,
      playedMs,
      skipRequested: this.skipRequested,
      goingBack: this.goingBack,
      loopMode: this.loopMode,
      retriedUrl: this.retriedUrl,
    };
    const early = earlyEndWarning({ ...end, prefetched: this.currentPrefetched, stopped: false });
    if (early) this.logger.warn(early);
    const next = afterTrackEnds(end);

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

    let stationMisses = 0;
    try {
      while (!this.destroyed) {
        let next = takeNext(this.queue, this.loopMode, this.queueSnapshot);
        let picked = false;
        const station = this.station;
        if (!next && station && stationMisses < STATION_MISSES) {
          const pick = await station.upNext();
          // Taken off air meanwhile, or a request arrived while the station picked: look again.
          if (this.station !== station || this.queue.length > 0) continue;
          next = pick ?? undefined;
          picked = pick !== null;
        }
        if (!next) {
          this.startIdleTimer();
          return;
        }

        station?.starting(next);
        const playing = await this.playTrack(next);
        if (playing) return;
        if (picked) stationMisses += 1;
      }
    } finally {
      this.queuePumpRunning = false;
    }
  }

  private async playTrack(track: Track): Promise<boolean> {
    if (this.destroyed) return false;
    const gen = ++this.playGeneration;
    const previous = this.lastStarted;
    this.lastError = null;
    this.current = track;
    this.djLine = null;
    this.currentPrefetched = false;
    this.firesGeneration += 1;
    this.fireCount = 0;
    this.firesTouched = false;
    if (this.station) this.loadFireCount(track);

    try {
      this.logger.info(`Starting stream for: ${track.title} (${track.url})`);
      // The song loads while the DJ talks. The clock stops when the stream is
      // ready, so a long intro does not look like a slow download.
      // A break of a few minutes waits to open YouTube until just before it ends,
      // unless this song was already prefetched during the one before it.
      const prefetched = this.prefetched?.url === track.url;
      const longIntro = (this.station?.introWaitMs?.(track) ?? 0) >= LONG_INTRO_WAIT_MS;
      let streamStarted = Date.now();
      let prefetchedHit = false;
      let streamReadyMs = 0;
      let streamFailed = false;
      type Probed = { stream: Readable; type: StreamType } | null;
      let opening: Promise<Probed> | null = null;
      const begin = (): Promise<Probed> => {
        if (opening) return opening;
        streamStarted = Date.now();
        opening = this.openStream(track, gen).then(async (opened) => {
          if (!opened) return null;
          prefetchedHit = opened.prefetched;
          const probed = await probeStream(opened.stream);
          streamReadyMs = Date.now() - streamStarted;
          if (this.destroyed || gen !== this.playGeneration) {
            probed.stream.destroy();
            return null;
          }
          return probed;
        });
        opening.catch(() => {
          streamFailed = true;
        });
        return opening;
      };
      // Short intros, and a song already in memory, open now. A long break does not.
      if (!longIntro || prefetched) begin();
      const intro = await this.stationIntro(track, previous);
      const delayMs = streamOpenDelayMs(
        intro?.pcm?.length ? pcmSeconds(intro.pcm) : 0,
        prefetched || !longIntro,
      );
      if (delayMs === 0) begin();
      // A song that already failed keeps its dedication for the next one (`missed` below).
      if (intro && !streamFailed) {
        this.djLine = intro.text;
        if (!this.destroyed) void this.publishFreshNowPlaying(track).catch(() => {});
        if (intro.pcm) {
          this.station?.spoke?.(track);
          if (delayMs > 0) {
            const timer = setTimeout(() => begin(), delayMs);
            timer.unref?.();
            try {
              await this.playIntro(intro.pcm, gen);
            } finally {
              clearTimeout(timer);
            }
          } else {
            await this.playIntro(intro.pcm, gen);
          }
        }
      }
      // Skip during the intro cuts it short. Open the song now if it is not open yet.
      const pending = begin();
      if (this.destroyed || gen !== this.playGeneration) {
        void pending.then(
          (probed) => probed?.stream.destroy(),
          () => {},
        );
        return false;
      }
      const probed = await pending;
      if (!probed) {
        if (!this.destroyed && gen === this.playGeneration) this.station?.missed?.(track);
        return false;
      }

      const resource = createAudioResource(probed.stream, {
        inputType: probed.type,
        inlineVolume: true,
      });
      resource.volume?.setVolume(this.volume);
      this.current = track;
      this.currentResource = resource;
      this.currentPrefetched = prefetchedHit;
      this.player.play(resource);
      const readySec = (streamReadyMs / 1000).toFixed(1);
      const via = prefetchedHit ? ', prefetched' : '';
      this.logger.info(
        `Audio player started: ${track.title} (stream ready in ${readySec} s${via}; ${this.queue.length} still queued)`,
      );
      this.lastStarted = track;
      this.onTrackStart?.(track);

      // A DJ intro already brought this song's card down.
      if (!intro) {
        void this.publishFreshNowPlaying(track).catch((err: unknown) =>
          this.logger.debug('publishFreshNowPlaying failed:', err),
        );
      }
      this.prefetchNext();
      this.warmStation(track);
      return true;
    } catch (error) {
      if (!this.destroyed && gen === this.playGeneration) this.station?.missed?.(track);
      const lastMsg = error instanceof Error ? error.message : String(error);
      this.lastError = lastMsg;
      this.current = null;
      this.currentResource = null;
      this.logger.error(`Failed to play "${track.title}":`, error);
      this.logger.warn(`Skipping unplayable track "${track.title}" — continuing queue`);
      return false;
    }
  }

  /** The 🔥 count for the card. A press that landed first keeps its number. */
  private loadFireCount(track: Track): void {
    const generation = this.firesGeneration;
    const load = this.fireCountLoader;
    if (!load) return;
    void load(track)
      .then((count) => {
        if (this.applyFireCount(generation, count)) void this.refreshNowPlaying();
      })
      .catch((error: unknown) => this.logger.debug('Kitchen FM reactions:', error));
  }

  /** The station's intro for `track`, if it is ready in time. A repeat gets none. */
  private async stationIntro(track: Track, previous: Track | null): Promise<StationIntro | null> {
    const station = this.station;
    if (!station || track === previous) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitMs = station.introWaitMs?.(track) ?? INTRO_WAIT_MS;
    const started = Date.now();
    const pending = station.intro(track);
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    try {
      const intro = await Promise.race([pending, late]);
      if (intro?.pcm?.length) return intro;
      // The wait ended with no clip. One may still finish after the song has started.
      if (!intro) {
        void pending.then(
          (ready) => {
            if (!ready?.pcm?.length) return;
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            this.logger.info(
              `Kitchen FM voice: ready after the player stopped waiting (${seconds} s)`,
            );
          },
          () => {},
        );
      }
      return intro;
    } catch (error) {
      this.logger.debug('Station intro failed:', error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Play the DJ's PCM clip and wait for it to end. Skip and Stop cut it short. */
  private async playIntro(pcm: Buffer, gen: number): Promise<void> {
    try {
      const resource = createAudioResource(Readable.from([pcm], { objectMode: false }), {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
      if (this.destroyed || gen !== this.playGeneration) return;
      resource.volume?.setVolume(this.volume);
      this.introPlaying = true;
      this.player.play(resource);
      await entersState(this.player, AudioPlayerStatus.Idle, introPlayMs(pcm));
      const seconds = (resource.playbackDuration / 1000).toFixed(1);
      this.logger.info(`Kitchen FM DJ spoke for ${seconds} s`);
    } catch (error) {
      this.logger.warn('The DJ clip did not play through:', error);
      if (this.introPlaying) this.player.stop(true);
    } finally {
      this.introPlaying = false;
    }
  }

  /**
   * While a song plays, prepare the next intro. With nothing queued, also
   * start the station's next song so the hand-off is not a fresh yt-dlp.
   */
  private warmStation(current: Track): void {
    const station = this.station;
    if (!station || this.loopMode !== 'off') return;
    const queued = this.queue.find((track) => track !== current);
    void (queued ? Promise.resolve(queued) : station.upNext())
      .then((upcoming) => {
        if (!upcoming || this.station !== station || this.loopMode !== 'off') return null;
        const next = this.queue.find((track) => track !== this.current);
        if (!next) this.prefetchStation(station, upcoming);
        return station.intro(upcoming);
      })
      .catch((error: unknown) => this.logger.debug('Station could not prepare ahead:', error));
  }

  private streamUsable(stream: Readable): boolean {
    return !stream.destroyed && !stream.readableEnded && stream.readable;
  }

  private async openStream(
    track: Track,
    gen: number,
  ): Promise<{ stream: Readable; prefetched: boolean } | null> {
    const slot = this.prefetched?.url === track.url ? this.prefetched : null;
    // Some other song was warming: it is not next any more.
    if (!slot) this.invalidatePrefetch();
    if (slot) {
      slot.taken = true;
      this.prefetched = null;
      await slot.ready;
      if (
        !slot.drop &&
        slot.stream &&
        this.streamUsable(slot.stream) &&
        !this.destroyed &&
        gen === this.playGeneration
      ) {
        return { stream: slot.stream, prefetched: true };
      }
      try {
        slot.stream?.destroy();
      } catch {
        /* ignore */
      }
    }

    // The show's prepared opener arrives with its audio already downloaded.
    const preloaded = this.station?.preloadedAudio?.(track);
    if (preloaded?.length) {
      return { stream: Readable.from([preloaded], { objectMode: false }), prefetched: true };
    }

    const fresh = await this.source.stream(track);
    if (this.destroyed || gen !== this.playGeneration) {
      fresh.destroy();
      return null;
    }
    return { stream: fresh, prefetched: false };
  }

  private invalidatePrefetch(): void {
    const slot = this.prefetched;
    this.prefetched = null;
    if (!slot) return;
    slot.drop = true;
    try {
      slot.stream?.destroy();
    } catch {
      /* ignore */
    }
  }

  /** Start `track` if that url is not already warming. `keep` runs when bytes arrive. */
  private prefetchTrack(track: Track, keep: (url: string) => boolean): void {
    if (this.destroyed) return;
    if (this.prefetched?.url === track.url) return;
    this.invalidatePrefetch();
    const url = track.url;
    const gen = this.playGeneration;
    let settle = (): void => {};
    const slot = {
      url,
      stream: null as Readable | null,
      drop: false,
      taken: false,
      ready: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.prefetched = slot;
    void this.source
      .stream(track)
      .then((raw) => {
        // A request that landed in the queue, or a new prefetch, wins over this one.
        // A taken slot belongs to playTrack, which checks its own generation.
        const stale =
          slot.drop ||
          this.destroyed ||
          (!slot.taken && (gen !== this.playGeneration || !keep(url)));
        if (stale) {
          raw.destroy();
          if (this.prefetched === slot) this.prefetched = null;
          return;
        }
        // Destroying the buffer (skip, shuffle) also ends yt-dlp.
        slot.stream = bufferStream(raw, PREFETCH_BYTES);
      })
      .catch(() => {
        if (this.prefetched === slot) this.prefetched = null;
      })
      .finally(settle);
  }

  private prefetchNext(): void {
    const next = this.queue.find((track) => track !== this.current);
    if (!next || this.destroyed) return;
    this.prefetchTrack(next, (url) => {
      const queued = this.queue.find((track) => track !== this.current);
      return queued?.url === url;
    });
  }

  /**
   * Warm the station's upcoming pick. A queued request already warming, or a
   * different song now at the front, is left alone.
   */
  private prefetchStation(station: PlayerStation, upcoming: Track): void {
    if (this.destroyed || this.station !== station || this.loopMode !== 'off') return;
    if (this.queue.find((track) => track !== this.current)) return;
    this.prefetchTrack(upcoming, (url) => {
      const queued = this.queue.find((track) => track !== this.current);
      if (queued) return queued.url === url;
      if (this.station !== station || this.loopMode !== 'off') return false;
      return station.queued()?.url === url;
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
    this.station?.end();
    this.station = null;
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
