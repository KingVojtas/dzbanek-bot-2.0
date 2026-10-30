import type { Guild, GuildMember, SendableChannels, VoiceBasedChannel } from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { RadioCatchStore } from '../kitchen/catches';
import type { MusicManager } from '../music/MusicManager';
import type { Track } from '../core/types';
import { dedupeSongs, songFromCatch, songFromTrack } from '../quiz/songs';
import type { PlayLogKind, PlayLogStore, PlayedTrackStore } from '../quiz/stores';
import { createCatalog, type DeezerTop, type FmCatalog } from './catalog';
import { FmStation } from './FmStation';
import { GenreBook, genreCachePath } from './GenreBook';
import { JingleLibrary } from './jingles';
import { genreName, genreQuery, playlistFits, type GenreId, type GenreIndex } from './genres';
import { GENRE_LIST_MS, rememberList, rotationAfter, type RotationCursor } from './rotation';
import { readWhole, type PreparedOpener } from './opener';
import {
  playFromFire,
  reactionSongKey,
  type ReactionKind,
  type SongReactionStore,
} from './reactions';
import type { DjLanguage, FmSong } from './script';
import { DjVoice } from './voice';
import { DjWriter } from './writer';

/** Fewer kitchen songs than this and the station would repeat itself at once. */
export const FM_MIN_SONGS = 3;
/** A /play newer than this stays off the station, the same as a song it aired itself. */
const RECENT_PLAY_MS = 24 * 60 * 60 * 1000;
/** Boot preparation waits so startup is not competing with it. */
const BOOT_DELAY_MS = 30_000;
/** One server, then a short pause, so the YouTube and Deezer gates are not piled up. */
const PREPARE_GAP_MS = 3_000;
/** Openers prepared on boot. The rest wait until a show on that server ends. */
const BOOT_SERVERS = 10;
/** A prepared line Edge dropped is asked for again this many times, this far apart. */
const OPENER_VOICE_RETRIES = 3;
const OPENER_VOICE_RETRY_MS = 2 * 60_000;
/** A prepared song bigger than this is not kept in memory: the player's own prefetch cap. */
const PRELOAD_MAX_BYTES = 16 * 1024 * 1024;
/** Prepared songs across every server stay under this. */
const PRELOAD_TOTAL_BYTES = 64 * 1024 * 1024;
const PRELOAD_TIMEOUT_MS = 90_000;

/** Stand-ins for the catalog, the genre cache, the voice, and the clock. */
export interface KitchenFmOptions {
  now?: () => number;
  catalog?: FmCatalog;
  genres?: GenreIndex;
  voice?: DjVoice;
  /** Station IDs and promos. A miss here does not rest the DJ's voice. */
  jingle?: DjVoice;
  /**
   * Sung jingles. Null skips them. Omitted reads `assets/fm/jingles`.
   * The file is joined when a clip is played, not when an opener is prepared.
   */
  jingles?: JingleLibrary | null;
  /** How long to wait before asking Edge again for a prepared line it dropped. */
  voiceRetryMs?: number;
}

/**
 * How a track start is filed. A new find wins over a plain station pick.
 * A dedication is a request the DJ was asked to introduce, not a station song.
 */
export function playLogKind(
  track: { stationPick?: boolean },
  about: { how: 'play' | 'catch' | 'new'; dedicated: boolean } | null,
): PlayLogKind {
  if (about?.how === 'new') return 'find';
  if (track.stationPick) return 'fm';
  if (about?.dedicated) return 'dedication';
  return 'play';
}

/**
 * Kitchen FM: the server's own station. It plays the kitchen's songs (every
 * /play and every 🍪 catch) in blocks of about fifteen songs, one genre then
 * the next, with a spoken break between them. /play requests still go first.
 * No API key.
 */
export class KitchenFm {
  private readonly stations = new Map<string, FmStation>();
  private readonly writer: DjWriter;
  private readonly voice: DjVoice;
  private readonly jingle: DjVoice;
  private readonly jingles: JingleLibrary | null;
  private readonly genres: GenreIndex;
  private readonly catalog: FmCatalog;
  /** Find queries YouTube could not match, per server, for the life of the process. */
  private readonly deadFinds = new Map<string, { artist: string; title: string }[]>();
  /** Genre the previous show on this server ended on, so the next one starts after it. */
  private readonly rotationCursors = new Map<string, RotationCursor>();
  /** Deezer playlist tracks, one list per genre, shared by every server. */
  private readonly genreLists = new Map<string, { at: number; items: Promise<DeezerTop[]> }>();
  /** The next show's opener, one per server. Gone once that show uses it or drops it. */
  private readonly prepared = new Map<string, PreparedOpener>();
  /** A preparation already running, so a second one for the same server waits on it. */
  private readonly preparing = new Map<string, Promise<void>>();
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundStopped = false;
  private gapMs = PREPARE_GAP_MS;
  private readonly voiceRetryMs: number;

  constructor(
    private readonly music: MusicManager,
    private readonly played: PlayedTrackStore,
    private readonly catches: RadioCatchStore,
    private readonly reactions: SongReactionStore,
    private readonly playLog: PlayLogStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly options: KitchenFmOptions = {},
  ) {
    this.writer = new DjWriter(config.dj.model, logger, {
      setsPerServerPerDay: config.dj.setsPerServerPerDay,
      setsPerDay: config.dj.setsPerDay,
      timezone: config.timezone,
    });
    this.voice = options.voice ?? new DjVoice(config.dj.voice, logger);
    this.voiceRetryMs = options.voiceRetryMs ?? OPENER_VOICE_RETRY_MS;
    this.jingle =
      options.jingle ?? new DjVoice(config.dj.jingleVoice ?? 'en-GB-RyanNeural', logger);
    this.jingles =
      options.jingles !== undefined
        ? options.jingles
        : new JingleLibrary({
            warn: (message) => logger.warn(message),
          });
    this.catalog = options.catalog ?? createCatalog();
    this.genres = options.genres ?? new GenreBook(genreCachePath(), this.catalog, logger);
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A set may bring songs the kitchen never played, from related artists. */
  get findsNew(): boolean {
    return this.config.dj.discover > 0;
  }

  /** The line book the DJ is speaking. Dedications use it for `{song}`. */
  get language(): DjLanguage {
    return this.config.dj.language;
  }

  /** English genre name for a song key, when the cache knows it. */
  genreOf(songKey: string): string | undefined {
    const id = this.genres.genreOf(songKey);
    return id ? genreName(id, 'en') : undefined;
  }

  /**
   * What the play log should store for a track that just started.
   * The station's pool key wins when the show handed the track out.
   */
  describe(
    guildId: string,
    track: Track,
  ): { key: string; kind: PlayLogKind; artist: string; title: string } {
    const song = songFromTrack(track, { kind: 'play' });
    const station = this.stations.get(guildId);
    const about = station?.aboutTrack(track) ?? null;
    const artist = (about?.artist.trim() ? about.artist : song.artist).slice(0, 200);
    const title = (about?.title.trim() ? about.title : song.title).slice(0, 300);
    return {
      key: station?.keyOf(track) || song.key,
      kind: playLogKind(track, about),
      artist,
      title,
    };
  }

  isOn(guildId: string): boolean {
    return this.stations.has(guildId);
  }

  /** Every song the kitchen played or caught, newest plays first. A play beats a catch of the same song. */
  async pool(guildId: string): Promise<FmSong[]> {
    const [plays, caught, tally] = await Promise.all([
      this.played.all(guildId),
      this.catches.between(guildId, new Date(0), new Date()),
      this.reactions.tally(guildId),
    ]);
    return dedupeSongs<FmSong>([
      ...plays.map((row) => ({
        ...songFromTrack(
          {
            title: row.title,
            url: row.url,
            uploader: row.uploader ?? undefined,
            durationSec: row.durationSec,
            thumbnail: row.thumbnail ?? undefined,
          },
          { kind: 'play', userId: row.requestedById ?? undefined },
        ),
        at: row.playedAt,
        videoTitle: row.title,
        uploader: row.uploader ?? undefined,
      })),
      ...caught.map((row) => ({
        ...songFromCatch(row),
        at: row.caughtAt,
        stationId: row.stationId,
      })),
    ]).map((song) => {
      const heat = tally.fires.get(song.key) ?? 0;
      const nopes = tally.nopes.get(song.key) ?? 0;
      return heat || nopes ? { ...song, heat, nopes } : song;
    });
  }

  /**
   * Join `voice` and go on air. Music already playing carries on, and the
   * station takes over when its queue ends. Returns how many songs it has.
   */
  async start(voice: VoiceBasedChannel, text: SendableChannels | null): Promise<number> {
    const guild = voice.guild;
    const kitchen = await this.pool(guild.id);
    const songs = kitchen.length;
    if (songs < FM_MIN_SONGS) {
      throw new Error(
        `Kitchen FM needs at least ${FM_MIN_SONGS} kitchen songs and found ${songs}. ` +
          '`/play` a few, or 🍪 Catch some off the radio.',
      );
    }

    const player = await this.music.join(voice);
    if (text) player.setAnnounceChannel(text);
    this.genres.enqueue(kitchen);
    if (player.onAir && this.stations.has(guild.id)) return songs;

    const station = this.createStation(guild, () => {
      if (this.stations.get(guild.id) === station) this.stations.delete(guild.id);
      this.logger.info(`Kitchen FM off the air in ${guild.name}.`);
      void this.prepareNext(guild);
    });
    this.stations.set(guild.id, station);
    player.setStation(station);
    this.logger.info(`Kitchen FM on air in ${guild.name} (#${voice.name}), ${songs} songs.`);
    return songs;
  }

  /** Find queries that missed on YouTube, kept until the process exits. */
  private deadFor(guildId: string): { artist: string; title: string }[] {
    let list = this.deadFinds.get(guildId);
    if (!list) {
      list = [];
      this.deadFinds.set(guildId, list);
    }
    return list;
  }

  /** Genre the last show on this server ended on. Null before the first one. */
  private cursorFor(guildId: string): RotationCursor {
    let cursor = this.rotationCursors.get(guildId);
    if (!cursor) {
      cursor = { genre: null };
      this.rotationCursors.set(guildId, cursor);
    }
    return cursor;
  }

  /** The genre a new show on this server would open with. Rock when none has ended. */
  openingGenre(guildId: string): GenreId {
    return rotationAfter(this.rotationCursors.get(guildId)?.genre ?? null);
  }

  /** Playlist tracks for one genre, fetched at most once every 12 hours. */
  private tracksFor(genre: GenreId): Promise<DeezerTop[]> {
    const query = genreQuery(genre);
    if (!query) return Promise.resolve([]);
    return rememberList(this.genreLists, genre, this.clock(), GENRE_LIST_MS, () =>
      this.catalog.genreTracks(query, (title) => playlistFits(genre, title)),
    );
  }

  /**
   * Prepare openers in the background, once shortly after boot.
   * A show that ends prepares the next one itself.
   * The constructor stays free of timers; call `stopBackgroundWork` on shutdown.
   */
  startBackgroundWork(
    guilds: () => Iterable<{ id: string; name: string }>,
    timing?: { bootDelayMs?: number; gapMs?: number },
  ): void {
    this.stopBackgroundWork();
    this.backgroundStopped = false;
    this.gapMs = timing?.gapMs ?? PREPARE_GAP_MS;
    const bootDelay = timing?.bootDelayMs ?? BOOT_DELAY_MS;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      if (this.backgroundStopped) return;
      void this.prepareAtBoot(guilds).catch((error: unknown) => {
        this.logger.warn('Kitchen FM could not prepare openers:', error);
      });
    }, bootDelay);
    this.bootTimer.unref?.();
  }

  /** Stop boot preparation. A show already on air is left alone. */
  stopBackgroundWork(): void {
    this.backgroundStopped = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  /** The opener stored for the next show on this server, if there is one. */
  openerFor(guildId: string): PreparedOpener | null {
    return this.prepared.get(guildId) ?? null;
  }

  /**
   * Find and voice the next show's first song. Does nothing while a show is on
   * or while a preparation for this server is already running. A failure leaves
   * no new opener; the next show starts the usual way.
   */
  prepareNext(guild: { id: string; name: string }): Promise<void> {
    if (this.backgroundStopped || this.stations.has(guild.id)) return Promise.resolve();
    const existing = this.preparing.get(guild.id);
    if (existing) return existing;
    const job = this.runPrepare(guild).finally(() => {
      if (this.preparing.get(guild.id) === job) this.preparing.delete(guild.id);
    });
    this.preparing.set(guild.id, job);
    return job;
  }

  private createStation(guild: Guild, onEnd: () => void, preparing = false): FmStation {
    return new FmStation(
      {
        guild,
        listeners: () => this.listeners(guild),
        pool: () => this.pool(guild.id),
        source: this.music.trackSource,
        writer: this.writer,
        voice: this.voice,
        language: this.config.dj.language,
        voiceName: this.config.dj.voice,
        discover: this.config.dj.discover,
        blockSets: this.config.dj.blockSets,
        blockSongs: this.config.dj.blockSongs,
        breakSeconds: this.config.dj.breakSeconds,
        jingle: this.jingle,
        jingles: this.jingles,
        genres: this.genres,
        catalog: this.catalog,
        findBlocks: async () => (await this.reactions.tally(guild.id)).blocked,
        aired: () => this.playLog.aired(guild.id, new Date(this.clock() - RECENT_PLAY_MS)),
        deadFinds: this.deadFor(guild.id),
        rotationCursor: this.cursorFor(guild.id),
        genreTracks: (genre) => this.tracksFor(genre),
        prepared: preparing ? null : (this.prepared.get(guild.id) ?? null),
        consumeOpener: preparing
          ? undefined
          : () => {
              this.prepared.delete(guild.id);
            },
        now: () => this.clock(),
        timezone: this.config.timezone,
        logger: this.logger,
      },
      onEnd,
    );
  }

  private async runPrepare(guild: { id: string; name: string }): Promise<void> {
    try {
      if (this.backgroundStopped || this.stations.has(guild.id)) return;
      const station = this.createStation(guild as Guild, () => {}, true);
      const found = await station.prepareOpener();
      if (this.backgroundStopped || this.stations.has(guild.id)) return;
      if (!found) {
        this.logger.warn(`Kitchen FM in ${guild.name}: could not prepare the next opener.`);
        return;
      }
      // The line and the song's audio are fetched side by side.
      const [pcm, audio] = await Promise.all([
        this.voice.speak(found.line).catch((error: unknown) => {
          this.logger.warn('Kitchen FM intro failed:', error);
          return null;
        }),
        this.preloadAudio(guild, found.track),
      ]);
      if (this.backgroundStopped || this.stations.has(guild.id)) return;
      const opener: PreparedOpener = {
        ...found,
        pcm,
        audio,
        preparedAt: this.clock(),
        language: this.config.dj.language,
        voice: this.config.dj.voice,
      };
      this.prepared.set(guild.id, opener);
      const seconds = opener.pcm?.length
        ? (opener.pcm.length / (48_000 * 2 * 2)).toFixed(1)
        : '0.0';
      const song = audio?.length
        ? `${(audio.length / 1024 / 1024).toFixed(1)} MB`
        : 'not downloaded';
      this.logger.info(
        `Kitchen FM in ${guild.name}: next opener ready: "${opener.artist} - ${opener.title}" (${genreName(opener.genre, this.config.dj.language)}), clip ${seconds} s, song ${song}.`,
      );
      if (!opener.pcm?.length) this.retryOpenerVoice(guild, opener, 1);
    } catch (error: unknown) {
      this.logger.warn(`Kitchen FM in ${guild.name}: could not prepare the next opener:`, error);
    }
  }

  /**
   * The opener's whole song, downloaded now so the show does not wait about
   * five seconds for YouTube. Null when it fails, is too big, or the other
   * servers' openers already hold enough memory.
   */
  private async preloadAudio(
    guild: { id: string; name: string },
    track: Track,
  ): Promise<Buffer | null> {
    let held = 0;
    for (const [id, opener] of this.prepared) {
      if (id !== guild.id) held += opener.audio?.length ?? 0;
    }
    if (held + PRELOAD_MAX_BYTES > PRELOAD_TOTAL_BYTES) return null;
    try {
      const stream = await this.music.trackSource.stream(track);
      return await readWhole(stream, PRELOAD_MAX_BYTES, PRELOAD_TIMEOUT_MS);
    } catch (error: unknown) {
      this.logger.warn(`Kitchen FM in ${guild.name}: could not download the next opener:`, error);
      return null;
    }
  }

  /**
   * Edge dropped the prepared line. There is usually no hurry before the next
   * show, so ask again a little later, a few times. A show that starts first
   * synthesizes the line itself, as before.
   */
  private retryOpenerVoice(
    guild: { id: string; name: string },
    opener: PreparedOpener,
    attempt: number,
  ): void {
    if (attempt > OPENER_VOICE_RETRIES) return;
    const timer = setTimeout(() => {
      const current = (): boolean =>
        !this.backgroundStopped &&
        this.prepared.get(guild.id) === opener &&
        !this.stations.has(guild.id);
      if (!current()) return;
      void this.voice
        .speak(opener.line)
        .catch(() => null)
        .then((pcm) => {
          if (!current()) return;
          if (!pcm?.length) {
            this.retryOpenerVoice(guild, opener, attempt + 1);
            return;
          }
          opener.pcm = pcm;
          const seconds = (pcm.length / (48_000 * 2 * 2)).toFixed(1);
          this.logger.info(
            `Kitchen FM in ${guild.name}: the next opener's line is voiced now (try ${attempt + 1}), clip ${seconds} s.`,
          );
        });
    }, this.voiceRetryMs);
    timer.unref?.();
  }

  private async prepareAtBoot(guilds: () => Iterable<{ id: string; name: string }>): Promise<void> {
    let started = 0;
    let gap = false;
    for (const guild of guilds()) {
      if (this.backgroundStopped || started >= BOOT_SERVERS) return;
      if (this.stations.has(guild.id)) continue;
      let songs: number;
      try {
        songs = (await this.pool(guild.id)).length;
      } catch (error: unknown) {
        this.logger.warn(`Kitchen FM in ${guild.name}: could not read the kitchen:`, error);
        continue;
      }
      if (songs < FM_MIN_SONGS) continue;
      if (gap) await this.pause(this.gapMs);
      gap = true;
      started += 1;
      await this.prepareNext(guild);
    }
  }

  private pause(ms: number): Promise<void> {
    if (ms <= 0 || this.backgroundStopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * Queue a dedication on the show that is on now. `track` null is read before
   * the next song. The clip starts here, before that song does.
   */
  dedicate(
    guildId: string,
    input: {
      userId: string;
      from: string;
      to: string;
      message: string;
      track: Track | null;
      song: string;
    },
  ): 'off' | 'ok' | 'yours' | 'full' {
    const station = this.stations.get(guildId);
    if (!station) return 'off';
    return station.dedicate(input);
  }

  /** Whether this person can send a dedication on the show that is on. */
  dedicationBlock(guildId: string, userId: string): 'off' | 'ok' | 'yours' | 'full' {
    const station = this.stations.get(guildId);
    if (!station) return 'off';
    return station.dedicationBlock(userId);
  }

  /** 🔥 or 👎 on the song that is on. Returns the 🔥 count after the press. */
  async react(guildId: string, userId: string, track: Track, kind: ReactionKind): Promise<number> {
    const song = songFromTrack(track, { kind: 'play' });
    const key = this.songKey(guildId, track);
    const result = await this.reactions.toggle(
      guildId,
      userId,
      { songKey: key, url: track.url, title: song.title, artist: song.artist },
      kind,
    );
    if (result.firstFire) {
      const known = await this.knows(guildId, key);
      const credit = playFromFire(track, userId, known, true);
      if (credit) await this.played.record(guildId, credit);
    }
    return result.fires;
  }

  /** 🔥 on the song that is on, for the Now Playing card. */
  async fires(guildId: string, track: Track): Promise<number> {
    const key = this.songKey(guildId, track);
    if (!key || key === '|') return 0;
    return this.reactions.fires(guildId, key);
  }

  /** The station's pool key when it handed this track out, otherwise the track's own. */
  private songKey(guildId: string, track: Track): string {
    return reactionSongKey(track, this.stations.get(guildId)?.keyOf(track) ?? null);
  }

  /** End the show and leave voice. False when Kitchen FM was not on. */
  stop(guildId: string): boolean {
    const player = this.music.get(guildId);
    if (!this.stations.has(guildId) || !player?.onAir) return false;
    player.stop();
    return true;
  }

  /** True when this song is already a kitchen play or a 🍪 catch. */
  private async knows(guildId: string, key: string): Promise<boolean> {
    const [plays, caught] = await Promise.all([
      this.played.all(guildId),
      this.catches.between(guildId, new Date(0), new Date()),
    ]);
    for (const row of plays) {
      const song = songFromTrack(
        {
          title: row.title,
          url: row.url,
          uploader: row.uploader ?? undefined,
          durationSec: row.durationSec,
          thumbnail: row.thumbnail ?? undefined,
        },
        { kind: 'play' },
      );
      if (song.key === key) return true;
    }
    return caught.some((row) => songFromCatch(row).key === key);
  }

  /** People in the voice channel the bot is in now; someone may have moved it. */
  private listeners(guild: Guild): GuildMember[] {
    const channelId = this.music.get(guild.id)?.connection.joinConfig.channelId;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()].filter((member) => !member.user.bot);
  }
}
