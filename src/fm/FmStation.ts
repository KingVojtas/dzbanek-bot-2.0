import type { Guild, GuildMember } from 'discord.js';
import type { Logger } from '../core/logger';
import type { HeardGreeting, OpeningClip, PlayerStation, StationIntro, Track } from '../core/types';
import { firstSongGreeting } from '../music/opening-rules';
import { zonedParts } from '../kitchen/time';
import type { CompositeTrackSource } from '../music/sources';
import { getStation } from '../radio/station';
import { songFromTrack } from '../quiz/songs';
import type { AiredSong } from '../quiz/stores';
import type { DeezerTop, FmCatalog } from './catalog';
import { DedicationQueue, dedicationText, type WaitingDedication } from './dedications';
import { JingleLibrary, openingJingle, type JingleFile } from './jingles';
import type { GenreId, GenreIndex } from './genres';
import { genreName } from './genres';
import { rotationAfter, GENRE_ROTATION, type RotationCursor } from './rotation';
import type { LineBook } from './lines';
import {
  openerDropReason,
  openerIsBlocked,
  openerYoung,
  preparedShowLine,
  timelessOpener,
  type PreparedOpener,
} from './opener';
import { pcmLoudness, type DjSpeaker } from './voice';
import type { DjWriter } from './writer';
import {
  CRATE_SIZE,
  SET_MAX,
  SET_MIN,
  isSameSong,
  plainTitle,
  pickSong,
  relativeDay,
  sampleCrate,
  sidelined,
  songFits,
  themeName,
  themedSet,
  type BlockedSongs,
  type DjLanguage,
  type FmSong,
  type OpenerSong,
  type PlannedSong,
  type Theme,
} from './script';
import { StationAired } from './station-aired';
import { StationIntros } from './station-intros';
import { blockSongCount, breakLength, StationBreaks } from './station-breaks';
import { NEW_FIND, StationDiscover } from './station-discover';
import type { FmSet, SetBase } from './station-types';
import {
  blockProfile,
  findAllowance,
  genreSongs,
  kitchenSlots,
  nextGenre,
  tasteProfile,
} from './taste';

/** A set still waiting behind requests after this long is planned again: its line names the time. */
const STALE_MS = 20 * 60_000;
/** Tries to top up a set whose songs would not load. */
const FILL_TRIES = 4;
/**
 * The show's first line, when it was not prepared ahead. The music waits no
 * longer than this for it: a slow voice leaves the line on the card as text.
 */
const OPENER_WAIT_MS = 8_000;
/** A dedication is read whatever it costs: its clip starts when it is accepted. */
const DEDICATION_WAIT_MS = 25_000;
/** A between-blocks break is built ahead. The player still waits this long for it. */
const BREAK_WAIT_MS = 60_000;
/** Fewer unaired kitchen songs than this: one set of them, then sets of new finds. */
const SMALL_KITCHEN = 10;
/** What Claude hears of this show: its last vibes and songs. */
const VIBES_SHOWN = 6;

/** A pool song is this track: by its link, or by its title when the song has none. */
function playedMatches(song: FmSong, track: Track): boolean {
  if (song.url) return song.url === track.url;
  return song.key === songFromTrack(track, { kind: 'play' }).key;
}

export interface FmStationDeps {
  guild: Guild;
  /** People (not bots) in the bot's voice channel right now. */
  listeners: () => GuildMember[];
  /** The kitchen's songs, read fresh for every set. */
  pool: () => Promise<FmSong[]>;
  source: CompositeTrackSource;
  writer: DjWriter;
  voice: DjSpeaker;
  language: DjLanguage;
  /** New finds a set may hold, songs the kitchen never played. */
  discover: number;
  /**
   * Sets in one taste block, from 1 to 4. The first taste block of a show is
   * still one set. Rotation blocks are counted in songs (`blockSongs`).
   */
  blockSets?: number;
  /** Station songs in one rotation block, from 5 to 30. Requests do not count. */
  blockSongs?: number;
  /** Seconds of break between rotation blocks. 0 keeps the usual block line. */
  breakSeconds?: number;
  /** Station IDs, promos, and outros. Separate from `voice`, so a miss does not rest the DJ. */
  jingle?: DjSpeaker;
  /** Sung jingles. A missing file falls back to the chime and the Edge voice. */
  jingles?: JingleLibrary | null;
  /** Genre cache. Blocks start once it knows enough of this server's songs. */
  genres?: GenreIndex;
  /** Deezer, for new finds inside a genre block. */
  catalog?: FmCatalog;
  /** New finds a 👎 retired. Read again for every set. */
  findBlocks?: () => Promise<readonly { artist: string; title: string }[]>;
  /**
   * Songs already aired. Read fresh for every set. A failed read counts as
   * nothing aired, and the show goes on.
   */
  aired?: () => Promise<readonly AiredSong[]>;
  /**
   * Find queries YouTube could not match. Shared by every show on this server
   * for the life of the process. The station appends to it.
   */
  deadFinds?: { artist: string; title: string }[];
  /** Genre the previous show on this server ended on. Updated in `end`. */
  rotationCursor?: RotationCursor;
  /** Playlist tracks for a genre. Cached by the process, so a warm show spends no Deezer calls. */
  genreTracks?: (genre: GenreId) => Promise<DeezerTop[]>;
  /** The DJ's line book. Loaded for `language` when omitted. */
  lines?: LineBook | null;
  /** `piper:<name>` or an Edge voice. A prepared opener voiced with another is dropped. */
  voiceName?: string;
  /**
   * First song of the next show, already found and voiced.
   * The station uses it for set 1 when it is still valid, then forgets it.
   */
  prepared?: PreparedOpener | null;
  /** Forget the stored opener once this show uses it or drops it. */
  consumeOpener?: () => void;
  /**
   * A short greeting voiced ahead of time. Null when it is missing or stale
   * (the server name, the language, or the voice changed).
   */
  backupGreeting?: () => Buffer | null;
  /** Clock for the block and for a set going stale. */
  now?: () => number;
  timezone: string;
  logger: Logger;
}

/** `mem://id-main.mp3` → `id-main`. The opening log names the file this way. */
function jingleStem(file: JingleFile): string {
  const base = file.file.replace(/\\/g, '/').split('/').pop() ?? file.file;
  return base.replace(/\.(mp3|wav)$/i, '');
}

/**
 * Kitchen FM in one server, in the style of Spotify's DJ. When the queue runs
 * dry it plays sets of a few songs with one vibe, and the DJ talks once per
 * set: the time, the vibe, the first song, and who brought it in.
 */
export class FmStation implements PlayerStation {
  private current: FmSet | null = null;
  private pending: FmSet | null = null;
  private peeking: Promise<Track | null> | null = null;
  private readonly recent: string[] = [];
  private readonly vibes: string[] = [];
  /** "Artist – Title" of every song this show put on, so a new find is not suggested twice. */
  private readonly played: string[] = [];
  private readonly setOf = new WeakMap<Track, FmSet>();
  private readonly about = new WeakMap<Track, OpenerSong>();
  /** Pool key for a song this station handed out. A catch keeps its catch key. */
  private readonly songKeys = new WeakMap<Track, string>();
  /** The DJ already read this track's intro, so a failed start does not repeat it. */
  private readonly spoken = new WeakSet<Track>();
  private readonly dedications = new DedicationQueue();
  /** Handed over in `starting`, so an early `intro` cannot spend it. */
  private readonly dedicationOf = new WeakMap<Track, WaitingDedication>();
  /** Set lines, dedications, and the new-find jingle. */
  private readonly intros: StationIntros;
  private lastTheme: Theme['kind'] | undefined;
  /** Who was listening when the current set started. */
  private wasListening = new Set<string>();
  /** Requests, and the song already on when the station started. Pushed into `recent` at plan time. */
  private readonly justPlayed: Track[] = [];
  /** What already aired, and what this show has planned, so a song is not picked twice. */
  private readonly aired: StationAired;
  /** Related artists, playlists, and the YouTube searches for a new find. */
  private readonly finds: StationDiscover;
  /** The opener prepared before this show. Cleared once it is used or dropped. */
  private prepared: PreparedOpener | null = null;
  /** Line and clip for the prepared song, applied when that song publishes the set. */
  private heldLine: string | null = null;
  private heldClip?: Buffer;
  /** The prepared opener's audio, until the player asks for it. */
  private preloaded: { url: string; audio: Buffer } | null = null;
  /**
   * Finding the next show's first song, not playing it. Stops after one song
   * and does not speak. Listeners are not required.
   */
  private preparingOpener = false;
  /**
   * Set 1, published at its first song. Later songs land on `tracks` in the background.
   * Null for every later set, which is still built in full before it is queued.
   */
  private live: {
    base: SetBase;
    vibe: string;
    newBlock: boolean;
    /** The rotation genre this set is being built for. Null for any other set. */
    genre: GenreId | null;
    tracks: Track[] | null;
    set: FmSet | null;
    resolve: (set: FmSet | null) => void;
    /** The show ended, or this set was thrown out, so further songs are dropped. */
    ignore: boolean;
  } | null = null;
  /** The rotation block on air, and how many of its station songs are already planned. */
  private rotation: {
    genre: GenreId;
    songs: number;
    limit: number;
    artists: string[];
    /** No more sets. The next plan starts the following genre. */
    closed: boolean;
  } | null = null;
  /** The break between rotation blocks, and jingle files already played this show. */
  private readonly breaks: StationBreaks;
  /** Jingle files already played this show, so the next pick is a different one. */
  private get jingleUsed() {
    return this.breaks.jingleUsed;
  }
  /** The backup greeting already stood in for this show's first song. */
  private usedFallback = false;
  /** When the show went on air, for the first-song log. Null until then. */
  private onAirAt: number | null = null;
  /** The first song of the opener set has been logged. */
  private announcedFirst = false;
  /**
   * A thin genre is being filled to five songs while preparing an opener.
   * The one-song cap stays off until that fill decides the genre is playable.
   */
  private rotationScan = false;
  private ended = false;
  /** The genre block on air: how many sets it should hold, and how many are planned. */
  private block: { genre: GenreId; sets: number; limit: number } | null = null;
  private readonly blockHistory: GenreId[] = [];

  constructor(
    private readonly deps: FmStationDeps,
    private readonly onEnd: () => void,
  ) {
    this.prepared = deps.prepared ?? null;
    this.intros = new StationIntros({
      guildName: deps.guild.name,
      language: deps.language,
      voice: deps.voice,
      jingles: deps.jingles,
      logger: deps.logger,
      lines: deps.lines,
      ended: () => this.ended,
      setOf: (track) => this.setOf.get(track),
      about: (track) => this.about.get(track),
      dedications: this.dedications,
      dedicationOf: this.dedicationOf,
    });
    this.aired = new StationAired({
      logger: deps.logger,
      aired: deps.aired,
      deadFinds: deps.deadFinds,
      played: () => this.played,
    });
    this.breaks = new StationBreaks({
      guildName: deps.guild.name,
      language: deps.language,
      voice: deps.voice,
      jingle: deps.jingle,
      jingles: deps.jingles,
      blockSongs: deps.blockSongs,
      breakSeconds: deps.breakSeconds,
      logger: deps.logger,
      rotationCursor: deps.rotationCursor,
      preparingOpener: () => this.preparingOpener,
      ended: () => this.ended,
      rotation: () => this.rotation,
      about: (track) => this.about.get(track),
      speak: (base, vibe, first, newBlock) => this.intros.speak(base, vibe, first, newBlock),
    });
    this.finds = new StationDiscover({
      catalog: deps.catalog,
      youtube: deps.source.youtube,
      logger: deps.logger,
      genreTracks: deps.genreTracks,
      findBlocks: deps.findBlocks,
      ended: () => this.ended,
      oneSong: () => this.oneSong(),
      played: () => this.played,
      deadList: () => this.aired.deadList(),
      airedRows: () =>
        this.aired.airedNow.rows.map((row) => ({ artist: row.artist, title: row.title })),
      urlTaken: (url) => this.aired.plannedUrls.has(url) || this.aired.airedNow.urls.has(url),
      noteDead: (artist, title) => this.aired.noteDead(artist, title),
      place: (tracks, track) => this.place(tracks, track),
      rememberFind: (hit) => this.rememberFind(hit),
      aboutSet: (hit, about) => this.about.set(hit, about),
    });
  }

  upNext(): Promise<Track | null> {
    if (this.ended) return Promise.resolve(null);
    if (this.pending && this.now() - this.pending.plannedAt > STALE_MS) {
      if (this.live?.set === this.pending) this.live.ignore = true;
      this.pending = null;
      this.peeking = null;
    }
    this.peeking ??= this.peek().then(
      (track) => {
        // Nobody listening, or nothing playable: ask again next time.
        if (!track) this.peeking = null;
        return track;
      },
      (error: unknown) => {
        this.deps.logger.warn('Kitchen FM could not plan a set:', error);
        this.peeking = null;
        return null;
      },
    );
    return this.peeking;
  }

  queued(): Track | null {
    const current = this.current;
    if (current && current.next < current.tracks.length) return current.tracks[current.next]!;
    // The set's later songs are still loading. Planning another set would skip them.
    if (current?.filling) return null;
    return this.pending?.tracks[0] ?? null;
  }

  /** The pool key for a song this station handed out. Null for a request. */
  keyOf(track: Track): string | null {
    return this.songKeys.get(track) ?? null;
  }

  /**
   * Names the station has for `track`, and whether a dedication is bound to it.
   * Null when this station did not plan the track and has nothing to say over it.
   */
  aboutTrack(track: Track): {
    artist: string;
    title: string;
    how: 'play' | 'catch' | 'new';
    dedicated: boolean;
  } | null {
    const about = this.about.get(track);
    const dedicated = this.dedicationOf.has(track);
    if (!about && !dedicated) return null;
    return {
      artist: about?.artist ?? '',
      title: about?.title ?? '',
      how: about?.how ?? 'play',
      dedicated,
    };
  }

  /**
   * Read `message` before `track`, or before the next song when `track` is null.
   * The clip starts now, so playback is not waiting on it later.
   */
  dedicate(input: {
    userId: string;
    from: string;
    to: string;
    message: string;
    track: Track | null;
    song: string;
  }): 'ok' | 'yours' | 'full' {
    const block = this.dedications.block(input.userId);
    if (block) return block;
    const text = dedicationText(
      this.intros.lineBook?.of('dedication') ?? [],
      input,
      this.deps.language,
    );
    const dedication: WaitingDedication = { ...input, text, speech: Promise.resolve(null) };
    this.dedications.add(dedication);
    // Starts now, so playback is not waiting on a cold call later.
    this.intros.speakDedication(dedication);
    return 'ok';
  }

  /** Dedications still waiting. The show drops them when it ends. */
  pendingDedications(): number {
    return this.dedications.length;
  }

  /** Whether this person can send one now. */
  dedicationBlock(userId: string): 'ok' | 'yours' | 'full' {
    return this.dedications.block(userId) ?? 'ok';
  }

  /** The song on air when the station started. The next set leaves it out. */
  heard(track: Track): void {
    this.justPlayed.push(track);
  }

  starting(track: Track): void {
    this.justPlayed.push(track);
    this.intros.handDedication(track);
    const set = this.setOf.get(track);
    if (!set) return;
    if (set === this.pending && set.tracks[0] === track) {
      this.pending = null;
      this.current = set;
      this.vibes.push(set.vibe);
      this.wasListening = new Set(this.deps.listeners().map((member) => member.id));
    }
    // Requests and replays leave the set where it was.
    if (set !== this.current || set.tracks[set.next] !== track) return;
    set.next += 1;
    this.peeking = null;
  }

  /** The DJ read `track`'s intro. `missed` will not hand its dedication back. */
  spoke(track: Track): void {
    this.spoken.add(track);
  }

  /**
   * `track` never started. A dedication it had not read goes back in front,
   * for whatever song comes next. One that names this song is read without it.
   */
  missed(track: Track): void {
    if (this.ended || this.spoken.has(track)) return;
    const dedication = this.dedicationOf.get(track);
    if (!dedication) return;
    this.dedicationOf.delete(track);
    this.intros.combined.delete(track);
    const song = dedication.song.trim();
    if (song && dedication.text.includes(song)) {
      const text = dedicationText(
        this.intros.lineBook?.of('dedication') ?? [],
        { from: dedication.from, to: dedication.to, message: dedication.message, song: '' },
        this.deps.language,
      );
      const again: WaitingDedication = {
        ...dedication,
        track: null,
        song: '',
        text,
        speech: Promise.resolve(null),
      };
      this.dedications.returnFront(again);
      this.intros.speakDedication(again);
      return;
    }
    const again: WaitingDedication = { ...dedication, track: null };
    const existing = this.intros.dedicationClips.get(dedication);
    if (existing) this.intros.dedicationClips.set(again, existing);
    this.intros.dedicationClips.delete(dedication);
    if (existing) again.speech = existing;
    this.dedications.returnFront(again);
  }

  /**
   * The jingle that plays the moment the radio is switched on.
   * A young prepared opener gets a sweeper; otherwise the station ID.
   * Null when that file is missing or will not decode.
   */
  async openingClip(): Promise<OpeningClip | null> {
    const name = this.deps.guild.name;
    const lib = this.deps.jingles;
    if (!lib) {
      this.deps.logger.info(`Kitchen FM in ${name}: opening jingle skipped, no files.`);
      return null;
    }
    const file = openingJingle(lib.files(), this.preparedUsable(), this.jingleUsed, Math.random);
    if (!file) {
      this.deps.logger.info(`Kitchen FM in ${name}: opening jingle skipped, no files.`);
      return null;
    }
    try {
      const pcm = await lib.clip(file);
      if (!pcm?.length) {
        this.deps.logger.info(`Kitchen FM in ${name}: opening jingle skipped, decode failed.`);
        return null;
      }
      return { stem: jingleStem(file), pcm };
    } catch (error: unknown) {
      this.deps.logger.warn('Kitchen FM jingle failed:', error);
      this.deps.logger.info(`Kitchen FM in ${name}: opening jingle skipped, decode failed.`);
      return null;
    }
  }

  /** The moment the show went on air. The first-song log measures from here. */
  wentOnAir(at: number): void {
    this.onAirAt = at;
  }

  /**
   * The first song of the opener set started. Logged once. A request before
   * that set does not count, and neither does any later song.
   */
  songOnAir(track: Track, heard: HeardGreeting): void {
    if (this.announcedFirst || this.onAirAt === null) return;
    const set = this.setOf.get(track);
    if (!set?.opener || set.tracks[0] !== track) return;
    this.announcedFirst = true;
    const greeting = firstSongGreeting({
      heard,
      preparedClip: Boolean(set.preparedClip?.length),
    });
    const seconds = ((this.now() - this.onAirAt) / 1000).toFixed(1);
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: first song on air ${seconds} s after the show started (greeting: ${greeting}).`,
    );
  }

  intro(track: Track): Promise<StationIntro | null> {
    if (this.ended) return Promise.resolve(null);
    const dedication = this.dedicationOf.get(track);
    const setLine = this.intros.setIntro(track);
    if (!dedication) return setLine ?? Promise.resolve(null);
    const pending = this.intros.combined.get(track);
    if (pending) return pending;
    const next = this.intros.withDedication(track, dedication, setLine);
    this.intros.combined.set(track, next);
    return next;
  }

  /**
   * The opener is synthesized cold, so it may wait longer. A dedication's clip
   * starts when it is accepted, and the same longer wait covers one that was
   * only just accepted. Every other intro uses the player's usual wait.
   */
  introWaitMs(track: Track): number | undefined {
    const set = this.setOf.get(track);
    if (set?.breakClip && set.tracks[0] === track) {
      // The player asks this right before it waits, so the break's clock starts here.
      set.breakDue?.();
      return BREAK_WAIT_MS;
    }
    if (this.dedicationOf.get(track)) return DEDICATION_WAIT_MS;
    if (set?.opener && set.tracks[0] === track) return OPENER_WAIT_MS;
    return undefined;
  }

  /**
   * The backup greeting, once, for the show's first song. The words are the
   * set's own line; the clip is the short one voiced ahead of time.
   * A miss does not use up the one chance.
   */
  fallbackIntro(track: Track): StationIntro | null {
    if (this.ended || this.usedFallback) return null;
    const set = this.setOf.get(track);
    if (!set?.opener || set.tracks[0] !== track) return null;
    const pcm = this.deps.backupGreeting?.() ?? null;
    if (!pcm?.length) return null;
    this.usedFallback = true;
    return { text: set.line, pcm };
  }

  /** A prepared opener still inside its 12 hours, so the opening can be short. */
  private preparedUsable(): boolean {
    const opener = this.prepared;
    if (!opener) return false;
    return openerYoung(opener.preparedAt, this.now());
  }

  /** The prepared opener's downloaded audio, once, for that song only. */
  preloadedAudio(track: Track): Buffer | null {
    const held = this.preloaded;
    if (!held || held.url !== track.url) return null;
    this.preloaded = null;
    return held.audio;
  }

  vibeOf(track: Track): string | null {
    const vibe = this.setOf.get(track)?.vibe;
    if (!vibe) return null;
    if (this.about.get(track)?.how !== 'new') return vibe;
    const suffix = this.deps.language === 'cs' ? 'novinka' : 'new find';
    return `${vibe} · ${suffix}`;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.preloaded = null;
    if (this.live) this.live.ignore = true;
    this.breaks.rememberRotation();
    this.current?.wake?.();
    this.pending?.wake?.();
    this.dedications.clear();
    this.onEnd();
  }

  /**
   * The song the next show would open with, and a line that names no clock time.
   * Listeners are not required. Nothing is marked aired, and the voice is not called.
   * Null when the rotation has no playable song. Stops once one song is found.
   */
  async prepareOpener(): Promise<Omit<
    PreparedOpener,
    'pcm' | 'preparedAt' | 'language' | 'voice'
  > | null> {
    if (this.ended) return null;
    this.preparingOpener = true;
    try {
      const pool = (await this.deps.pool()).filter((song) => songFits(song.durationSec));
      await this.aired.readAired();
      const unaired = pool.filter((song) => !this.aired.taken(song));
      const base: SetBase = { hour: 0, minute: 0, set: 1, newcomers: [] };
      const set = await this.planRotation(pool, unaired, base, []);
      const track = set?.tracks[0];
      const block = this.rotation;
      if (!track || !block) return null;
      const about = this.about.get(track) ?? {
        artist: '',
        title: track.title,
        by: null,
        how: 'play' as const,
      };
      return {
        track,
        artist: about.artist,
        title: about.title,
        how: about.how,
        by: about.by,
        key: this.keyOf(track) ?? '',
        genre: block.genre,
        after: this.deps.rotationCursor?.genre ?? null,
        line: this.lineForLater(block.genre, about),
      };
    } finally {
      this.preparingOpener = false;
    }
  }

  /** Drop a prepared opener that would no longer open this show, and say why. */
  private async considerPrepared(pool: readonly FmSong[]): Promise<void> {
    const opener = this.prepared;
    if (!opener) return;
    const blocks = (await this.deps.findBlocks?.()) ?? [];
    const reason = openerDropReason(opener, {
      now: this.now(),
      language: this.deps.language,
      voice: this.deps.voiceName ?? '',
      airedKeys: this.aired.airedNow.keys,
      airedUrls: this.aired.airedNow.urls,
      plannedKeys: this.aired.plannedKeys,
      plannedUrls: this.aired.plannedUrls,
      after: this.deps.rotationCursor?.genre ?? null,
      blocked: openerIsBlocked(opener, pool, blocks),
    });
    if (reason) this.dropPrepared(reason);
  }

  private dropPrepared(reason: string): void {
    if (!this.prepared) return;
    this.prepared = null;
    this.heldLine = null;
    this.heldClip = undefined;
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: dropping the prepared opener, ${reason}.`,
    );
    this.deps.consumeOpener?.();
  }

  /**
   * Publish the prepared song as set 1's first track, then let the set fill behind it.
   * A preparation pass does not take it: that pass is finding the song.
   */
  private leadWithPrepared(tracks: Track[], genre: GenreId): void {
    const opener = this.prepared;
    if (!opener || this.preparingOpener || this.ended || opener.genre !== genre) return;
    this.prepared = null;
    const track = opener.track;
    track.stationPick = true;
    this.about.set(track, {
      artist: opener.artist,
      title: opener.title,
      by: opener.by,
      how: opener.how,
    });
    this.remember(track, opener.key);
    this.aired.markPlanned(opener.key, track.url);
    if (opener.key && opener.key !== '|') this.recent.push(opener.key);
    this.heldLine = opener.line;
    this.heldClip = opener.pcm?.length ? opener.pcm : undefined;
    this.preloaded = opener.audio?.length ? { url: track.url, audio: opener.audio } : null;
    const name = genreName(opener.genre, this.deps.language);
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: using the prepared opener "${opener.artist} - ${opener.title}" (${name}).`,
    );
    this.deps.consumeOpener?.();
    this.place(tracks, track);
  }

  /** A showOpen line with no clock in it, or the built-in greeting when the book has none. */
  private lineForLater(genre: GenreId, song: OpenerSong): string {
    const vibe = genreName(genre, this.deps.language);
    const slots = this.intros.slots({ hour: 0, minute: 0, set: 1, newcomers: [] }, vibe, song);
    return (
      preparedShowLine(this.intros.lineBook?.of('showOpen') ?? [], slots) ??
      timelessOpener({
        language: this.deps.language,
        server: this.deps.guild.name,
        vibe,
        song,
      })
    );
  }

  private async peek(): Promise<Track | null> {
    const queued = this.queued();
    if (queued) return queued;
    const filling = this.current?.filling
      ? this.current
      : this.pending?.filling
        ? this.pending
        : null;
    if (filling) {
      await this.waitForMore(filling);
      if (this.ended) return null;
      const next = this.queued();
      if (next) return next;
    }
    if (this.current?.filling || this.pending?.filling) return this.queued();
    this.pending = await this.plan();
    return this.pending?.tracks[0] ?? null;
  }

  /** Resolves when `set` gains a song or its background fill finishes. */
  private waitForMore(set: FmSet): Promise<void> {
    const pending = set.filling;
    if (!pending) return Promise.resolve();
    if (set.next < set.tracks.length) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = set.wake ?? null;
      set.wake = () => {
        previous?.();
        resolve();
      };
      void pending.finally(() => resolve());
    });
  }

  /** The next set: finds when the unaired kitchen is thin, else a block, Claude, or a theme. */
  private async plan(): Promise<FmSet | null> {
    const listeners = this.deps.listeners();
    if (listeners.length === 0) {
      this.deps.logger.info(`Kitchen FM in ${this.deps.guild.name}: nobody is listening.`);
      return null;
    }
    const pool = (await this.deps.pool()).filter((song) => songFits(song.durationSec));
    this.noteJustPlayed(pool);
    await this.aired.readAired();
    const unaired = pool.filter((song) => !this.aired.taken(song));
    const clock = zonedParts(this.deps.timezone);
    const number = this.vibes.length + 1;
    if (number === 1) {
      this.deps.logger.info(
        `Kitchen FM in ${this.deps.guild.name}: ${this.aired.airedNow.keys.size} songs already aired, ` +
          `${unaired.length} of ${pool.length} kitchen songs not aired yet.`,
      );
      await this.considerPrepared(pool);
    }
    const base: SetBase = {
      hour: clock.hour,
      minute: clock.minute,
      set: number,
      newcomers:
        number > 1
          ? listeners
              .filter((member) => !this.wasListening.has(member.id))
              .map((member) => member.displayName)
          : [],
    };
    const time = `${clock.weekday} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;

    // Set 1 goes on air at its first song. The rest of that set fills in behind it.
    if (number === 1) {
      const set = await this.planFirst(pool, unaired, base, listeners, time);
      if (this.prepared) this.dropPrepared('it did not fit the opening set');
      return set;
    }
    const set = await this.assemble(pool, unaired, base, listeners, time);
    if (!set || this.ended) return null;
    this.publish(set, number);
    return set;
  }

  /**
   * Publish set 1 as soon as one song is playable, and keep filling `tracks`.
   * `upNext` resolves on that first song. The "set 1" log waits for the final count.
   */
  private async planFirst(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
    time: string,
  ): Promise<FmSet | null> {
    let resolve!: (set: FmSet | null) => void;
    const ready = new Promise<FmSet | null>((settle) => {
      resolve = settle;
    });
    this.live = {
      base,
      vibe: '',
      newBlock: false,
      genre: null,
      tracks: null,
      set: null,
      resolve,
      ignore: false,
    };
    let finished = false;
    const work = this.assemble(pool, unaired, base, listeners, time).then(
      (set) => {
        finished = true;
        return this.live?.set ?? set;
      },
      (error: unknown) => {
        finished = true;
        this.deps.logger.warn('Kitchen FM could not finish the opening set:', error);
        return this.live?.set ?? null;
      },
    );
    const set = await Promise.race([ready, work]);
    if (!set || this.ended) {
      if (this.live) {
        this.live.ignore = true;
        this.live.resolve(null);
      }
      this.live = null;
      return null;
    }
    if (!finished) {
      const live = this.live;
      set.filling = work.then(() => {
        this.logSet(set, base.set);
        set.filling = null;
        set.wake?.();
        if (this.live === live) this.live = null;
      });
    } else {
      // A set that never went through `place` still needs its songs wired and its voice cued.
      if (set === this.live?.set) this.logSet(set, base.set);
      else this.publish(set, base.set);
      this.live = null;
    }
    return set;
  }

  /** The rotation, then finds, a taste block, Claude, a theme, or the oldest songs. */
  private async assemble(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
    time: string,
  ): Promise<FmSet | null> {
    const thin = unaired.length < SET_MIN;
    const small = unaired.length < SMALL_KITCHEN;
    let triedFinds = false;
    const findsFailed = (error: unknown): null => {
      this.deps.logger.warn('Kitchen FM could not plan a set of new finds:', error);
      return null;
    };
    let set: FmSet | null = await this.planRotation(pool, unaired, base, listeners);
    if (this.live?.set) return this.live.set;
    set =
      !set && (thin || (base.set > 1 && small))
        ? await this.planFinds(pool, unaired, base, listeners).catch(findsFailed)
        : set;
    if (thin || (base.set > 1 && small)) triedFinds = true;
    if (this.live?.set) return this.live.set;
    if (!set) {
      set = await this.planBlocks(pool, unaired, base, listeners).catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM could not plan a genre set:', error);
        return null;
      });
    }
    if (this.live?.set) return this.live.set;
    if (!set) set = await this.planWithClaude(unaired, base, time, listeners);
    if (this.live?.set) return this.live.set;
    if (!set) set = await this.planThemed(pool, unaired, base, listeners);
    if (this.live?.set) return this.live.set;
    if (!set && !triedFinds && !this.ended) {
      set = await this.planFinds(pool, unaired, base, listeners).catch(findsFailed);
    }
    if (this.live?.set) return this.live.set;
    if (!set && !this.ended) set = await this.planOldest(pool, base);
    if (this.live?.set) return this.live.set;
    return set;
  }

  /** Wire a finished set and log it. Set 1 does this itself, one song at a time. */
  private publish(set: FmSet, number: number): void {
    for (const track of set.tracks) this.rememberPlayed(set, track);
    this.logSet(set, number);
    set.opener = number === 1;
    this.cueVoice(set);
  }

  /** The "set N" line, with the song count the set actually ended up with. */
  private logSet(set: FmSet, number: number): void {
    const finds = set.tracks.filter((track) => this.about.get(track)?.how === 'new').length;
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: set ${number}, "${set.vibe}", ` +
        `${set.tracks.length} songs${finds ? ` (${finds} new)` : ''}: "${set.line}"`,
    );
  }

  /**
   * Name the set the opener is building, before its first song.
   * A planner that adds nothing gives the name back so the next planner can take it.
   */
  private claim(tracks: Track[], vibe: string, newBlock: boolean, genre?: GenreId | null): void {
    const live = this.live;
    // A planner that threw after its claim never released it, so an unpublished claim is taken over.
    if (!live || live.ignore || live.set) return;
    live.tracks = tracks;
    live.vibe = vibe;
    live.newBlock = newBlock;
    live.genre = genre ?? null;
  }

  private release(tracks: Track[]): void {
    const live = this.live;
    if (live && live.tracks === tracks && !live.set) live.tracks = null;
  }

  /** Append one playable song. The opener's first song publishes the set. */
  private place(tracks: Track[], track: Track): void {
    if (this.ended) return;
    const live = this.live;
    if (live?.ignore && live.tracks === tracks) return;
    if (tracks.some((item) => item.url === track.url)) return;
    tracks.push(track);
    if (!live || live.tracks !== tracks) return;
    if (!live.set) {
      const held = this.heldLine;
      const clip = this.heldClip;
      this.heldLine = null;
      this.heldClip = undefined;
      const set: FmSet = {
        vibe: live.vibe,
        line: held ?? this.intros.speak(live.base, live.vibe, track, live.newBlock),
        tracks,
        next: 0,
        plannedAt: this.now(),
        opener: true,
        blockStart: live.newBlock,
        rotationGenre: live.genre,
        preparedClip: clip,
      };
      live.set = set;
      this.rememberPlayed(set, track);
      this.cueVoice(set);
      live.resolve(set);
      return;
    }
    this.rememberPlayed(live.set, track);
    live.set.wake?.();
  }

  /** The pool key and the "already played" label for a song that joined a set. */
  private rememberPlayed(set: FmSet, track: Track): void {
    this.setOf.set(track, set);
    const song = this.about.get(track);
    if (!song) return;
    const label = song.artist ? `${song.artist} – ${song.title}` : song.title;
    if (!label.trim()) return;
    this.played.push(label);
    if (this.played.length > 200) this.played.splice(0, this.played.length - 200);
  }

  /**
   * The set object, already published when this is the opener's first song.
   * `holdLine` leaves the line empty: a break is about to replace it, and
   * speaking now would use up a block line the break may not need.
   */
  private sealed(
    base: SetBase,
    vibe: string,
    newBlock: boolean,
    tracks: Track[],
    holdLine = false,
    genre: GenreId | null = null,
  ): FmSet | null {
    if (this.live?.set && this.live.tracks === tracks) return this.live.set;
    if (!tracks[0] || this.ended) {
      this.release(tracks);
      return null;
    }
    return {
      vibe,
      line: holdLine ? '' : this.intros.speak(base, vibe, tracks[0], newBlock),
      tracks,
      next: 0,
      plannedAt: this.now(),
      blockStart: newBlock,
      rotationGenre: genre,
    };
  }

  /** Start the clip as soon as the set exists, and say how it came out. */
  private cueVoice(set: FmSet): void {
    if (this.preparingOpener) return;
    const first = set.tracks[0];
    if (!first) return;
    const started = Date.now();
    void this.intro(first).then((intro) => {
      if (!intro?.pcm?.length) return;
      // s16le, 48 kHz, stereo.
      const seconds = intro.pcm.length / (48_000 * 2 * 2);
      const db = Math.round(pcmLoudness(intro.pcm));
      const ready = ((Date.now() - started) / 1000).toFixed(1);
      this.deps.logger.info(
        `Kitchen FM voice: ${seconds.toFixed(1)} s, ${db} dBFS, ready in ${ready} s`,
      );
    });
  }

  private async planWithClaude(
    unaired: FmSong[],
    base: SetBase,
    time: string,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    if (!this.deps.writer.ready) return null;
    const open = unaired.filter((song) => !this.aired.plannedThisShow(song));
    // An empty crate with no finds allowed is a wasted call.
    if (open.length === 0 && (base.set === 1 || this.deps.discover <= 0)) return null;
    const crateSongs = sampleCrate(open, this.recent, CRATE_SIZE);
    const names = await this.namesOf(crateSongs);
    const plan = await this.deps.writer.planSet(
      {
        language: this.deps.language,
        server: this.deps.guild.name,
        time,
        ...base,
        earlierVibes: this.vibes.slice(-VIBES_SHOWN),
        playedThisShow: this.aired.playedForClaude(),
        listeners: listeners.map((member) => member.displayName),
        discover: base.set === 1 ? 0 : this.deps.discover,
        crate: crateSongs.map((song, i) => ({
          n: i + 1,
          artist: song.artist,
          title: song.title,
          by: names.get(song.from.userId ?? '') ?? null,
          how: song.from.kind === 'catch' ? 'catch' : 'play',
          when: relativeDay(song.at),
          station: song.stationId ? (getStation(song.stationId)?.name ?? null) : null,
        })),
      },
      this.deps.guild.id,
    );
    if (!plan) return null;

    const tracks: Track[] = [];
    this.claim(tracks, plan.vibe, false);
    const airedNames = this.aired.airedNames();
    const first = await this.loadPlannedOrdered(
      plan.songs,
      crateSongs,
      open,
      airedNames,
      base.set,
      tracks,
    );
    await this.fill(tracks, open);
    // Set 1 already spoke from its first song. A later set keeps Claude's line.
    if (this.live?.set && this.live.tracks === tracks) return this.live.set;
    const set = this.sealed(base, plan.vibe, false, tracks);
    if (!set) return null;
    if (first && plan.line) set.line = plan.line;
    return set;
  }

  private async planThemed(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const listenerMap = new Map(listeners.map((member) => [member.id, member.displayName]));
    const fresh = unaired.filter((song) => !this.aired.plannedThisShow(song));
    const picked =
      fresh.length > 0
        ? themedSet(fresh, [], { listeners: listenerMap, last: this.lastTheme })
        : null;
    // Set 1 is the kitchen's own songs. Later, a small unaired kitchen fills the gap with finds.
    const allowance =
      base.set === 1
        ? 0
        : fresh.length < SMALL_KITCHEN
          ? Math.min(this.findBudget(fresh.length), Math.max(0, SET_MAX - fresh.length))
          : this.findBudget(fresh.length);
    const chosen = (picked?.songs ?? []).slice(
      0,
      kitchenSlots(picked?.songs.length ?? 0, allowance),
    );
    const theme = picked?.theme ?? { kind: 'mix' as const };
    const vibe = themeName(theme, this.deps.language);
    const tracks: Track[] = [];
    this.claim(tracks, vibe, false);
    await this.loadOrdered(chosen, tracks);

    const index = this.deps.genres;
    if (allowance > 0 && this.deps.catalog && index && tracks.length < SET_MAX) {
      const listenerIds = new Set(listeners.map((member) => member.id));
      await this.finds.discover(pool, null, allowance, listenerIds, index, tracks);
    }
    await this.fill(tracks, fresh);
    const set = this.sealed(base, vibe, false, tracks);
    if (!set) return null;
    this.lastTheme = theme.kind;
    return set;
  }

  /**
   * One set inside a genre block, once enough songs have a genre. The first
   * block of a show is the server's favourite, and it is one set. Later blocks
   * run for `blockSets` sets. A genre out of unplayed songs starts the next one.
   * Only genres with `BLOCK_MIN_FRESH` unplayed songs get a block.
   */
  private async planBlocks(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const index = this.deps.genres;
    if (!index?.ready(pool)) return null;

    const now = this.now();
    const listenerIds = new Set(listeners.map((member) => member.id));
    const genreOf = (song: FmSong) => index.genreOf(song.key);
    const open = unaired.filter((song) => !this.aired.plannedThisShow(song));
    const profile = blockProfile(
      tasteProfile(pool, genreOf, { now, listenerIds }),
      open,
      this.recent,
      genreOf,
    );

    let genre = this.block?.genre ?? null;
    let fresh = false;
    const due = this.block !== null && this.block.sets >= this.block.limit;
    if (!genre) {
      genre = nextGenre(profile, [], Math.random);
      fresh = true;
    } else if (due) {
      const next = nextGenre(profile, this.blockHistory, Math.random);
      if (next && next !== genre) {
        genre = next;
        fresh = true;
      }
    }
    if (!genre) return null;

    let picked = genreSongs(open, this.recent, genre, genreOf);
    let finds = this.findBudget(picked.length);
    const runOut = picked.length < SET_MIN;
    if (this.block && !fresh && runOut) {
      const next = nextGenre(profile, this.blockHistory, Math.random);
      if (next && next !== genre) {
        genre = next;
        fresh = true;
        picked = genreSongs(open, this.recent, genre, genreOf);
        finds = this.findBudget(picked.length);
      } else {
        // No genre has enough unplayed songs for a block: the station's own sets take over.
        this.block = null;
        return null;
      }
    }
    if (fresh) index.enqueue(pool);

    const vibe = genreName(genre, this.deps.language);
    const tracks: Track[] = [];
    this.claim(tracks, vibe, fresh);
    await this.loadGenreSet(
      picked,
      pool,
      open,
      genre,
      base.set === 1 ? 0 : finds,
      listenerIds,
      index,
      tracks,
    );
    const set = this.sealed(base, vibe, fresh, tracks);
    if (!set) return null;
    if (fresh) {
      const limit = this.setsPerBlock(this.blockHistory.length === 0);
      this.block = { genre, sets: 0, limit };
      this.blockHistory.push(genre);
      const noun = limit === 1 ? 'set' : 'sets';
      this.deps.logger.info(
        `Kitchen FM in ${this.deps.guild.name}: ${genreName(genre, this.deps.language)} for ${limit} ${noun}.`,
      );
    }
    if (this.block) this.block.sets += 1;
    return set;
  }

  /**
   * A set of new finds from artists related to the kitchen's. A thin unaired
   * kitchen keeps its remaining songs in the set. A short find list is topped
   * up with unaired kitchen songs. Null when nothing was found.
   */
  private async planFinds(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const index = this.deps.genres;
    if (!this.deps.catalog || !index || this.deps.discover <= 0) return null;
    const listenerIds = new Set(listeners.map((member) => member.id));
    const open = unaired.filter((song) => !this.aired.plannedThisShow(song));
    const reserve = open.length < SET_MIN ? Math.min(open.length, SET_MAX) : 0;
    const vibe = this.deps.language === 'cs' ? 'podobní interpreti' : 'similar artists';
    const tracks: Track[] = [];
    this.claim(tracks, vibe, false);
    await this.finds.discover(pool, null, SET_MAX - reserve, listenerIds, index, tracks);
    if (tracks.length < SET_MAX) await this.fill(tracks, open);
    return this.sealed(base, vibe, false, tracks);
  }

  /**
   * Nothing new was found. Play the kitchen songs that aired longest ago so
   * the channel does not go quiet. Skips what this show already planned when
   * something else is left.
   */
  private async planOldest(pool: FmSong[], base: SetBase): Promise<FmSet | null> {
    this.deps.logger.warn(
      `Kitchen FM in ${this.deps.guild.name}: nothing new could be found. Playing songs that aired longest ago.`,
    );
    const list = pool.filter((song) => !sidelined(song));
    const waiting = list.filter((song) => !this.aired.plannedThisShow(song));
    const source = waiting.length > 0 ? waiting : list.length > 0 ? list : pool;
    const ordered = [...source].sort(
      (a, b) => this.aired.lastAiredAt(a) - this.aired.lastAiredAt(b) || a.key.localeCompare(b.key),
    );
    const vibe = themeName({ kind: 'throwbacks' }, this.deps.language);
    const tracks: Track[] = [];
    this.claim(tracks, vibe, false);
    for (const song of ordered) {
      if (tracks.length >= SET_MAX || this.ended) break;
      const track = await this.loadSong(song);
      if (track) this.place(tracks, track);
    }
    return this.sealed(base, vibe, false, tracks);
  }

  /** The opening block is one set. Later blocks use `blockSets`, clamped to 1–4. */
  private setsPerBlock(first: boolean): number {
    if (first) return 1;
    const sets = this.deps.blockSets ?? 2;
    if (!Number.isFinite(sets)) return 2;
    return Math.min(4, Math.max(1, Math.round(sets)));
  }

  /** Finds per set: none without Deezer, otherwise more when the genre is thin. */
  private findBudget(freshKitchen: number): number {
    if (!this.deps.catalog) return 0;
    return findAllowance(this.deps.discover, freshKitchen);
  }

  /** Kitchen songs of the genre, then Deezer finds, topped up if the set is still short. */
  private async loadGenreSet(
    picked: FmSong[],
    pool: FmSong[],
    unaired: FmSong[],
    genre: GenreId,
    finds: number,
    listenerIds: ReadonlySet<string>,
    index: GenreIndex,
    tracks: Track[],
  ): Promise<void> {
    const kitchen = picked.slice(0, kitchenSlots(picked.length, finds));
    await this.loadOrdered(kitchen, tracks);
    if (finds > 0 && this.deps.catalog && tracks.length < SET_MAX) {
      await this.finds.discover(pool, genre, finds, listenerIds, index, tracks);
    }
    // Top up only with unaired songs of the same genre: a short set beats one under the wrong name.
    const same = unaired.filter(
      (song) => index.genreOf(song.key) === genre && !this.aired.plannedThisShow(song),
    );
    await this.fill(tracks, same);
  }

  /** Preparing an opener loads one song, unless a thin genre is being proved. */
  private oneSong(): boolean {
    return this.preparingOpener && !this.rotationScan;
  }

  /**
   * The rotation, `blockSongs` station songs per genre. A genre with fewer
   * than five playable songs is skipped. Nothing in the whole list falls through.
   * Set 1 of a show is the first block, and it has no break in front of it.
   */
  private async planRotation(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    if (this.ended) return null;
    const index = this.deps.genres;
    const listenerIds = new Set(listeners.map((member) => member.id));
    const open = unaired.filter((song) => !this.aired.plannedThisShow(song));

    if (this.rotation && !this.rotation.closed && this.rotation.songs < this.rotation.limit) {
      const genre = this.rotation.genre;
      const cap = Math.min(SET_MAX, this.rotation.limit - this.rotation.songs);
      const set = await this.buildRotationSet(
        genre,
        pool,
        open,
        base,
        listenerIds,
        index,
        false,
        cap,
        false,
      );
      if (set?.tracks.length) {
        this.noteRotation(genre, set.tracks, cap);
        return set;
      }
      this.rotation.closed = true;
      this.breaks.startBreakHead();
    }

    // A show with a prepared opener starts at its genre: the preparation already
    // skipped the genres before it that had nothing to play.
    let genre = this.rotation
      ? rotationAfter(this.rotation.genre)
      : this.prepared && !this.preparingOpener
        ? this.prepared.genre
        : rotationAfter(this.deps.rotationCursor?.genre ?? null);
    const seen = new Set<GenreId>();
    for (let step = 0; step < GENRE_ROTATION.length; step += 1) {
      if (this.ended) return null;
      if (seen.has(genre)) break;
      seen.add(genre);
      const cap = Math.min(SET_MAX, blockSongCount(this.deps.blockSongs));
      const hold =
        base.set > 1 &&
        this.breaks.breakHead !== null &&
        breakLength(this.deps.breakSeconds) > 0 &&
        !this.preparingOpener;
      const set = await this.buildRotationSet(
        genre,
        pool,
        open,
        base,
        listenerIds,
        index,
        true,
        cap,
        hold,
      );
      if (set?.tracks.length) {
        // The previous block's break is already rendered. Take it before this
        // set, which may itself be a whole block, starts the next one.
        if (base.set > 1) this.breaks.armBreak(set, genre, base);
        this.noteRotation(genre, set.tracks, cap);
        return set;
      }
      this.deps.logger.info(
        `Kitchen FM in ${this.deps.guild.name}: no playable songs for ${genreName(genre, this.deps.language)}.`,
      );
      genre = rotationAfter(genre);
    }
    this.breaks.breakHead = null;
    return null;
  }

  /**
   * One rotation set. A new genre needs five playable songs before it is
   * claimed, so a thin shelf is not announced and then skipped. Enough fresh
   * kitchen songs publish set 1 at the first one.
   */
  private async buildRotationSet(
    genre: GenreId,
    pool: FmSong[],
    open: FmSong[],
    base: SetBase,
    listenerIds: ReadonlySet<string>,
    index: GenreIndex | undefined,
    newBlock: boolean,
    cap: number,
    holdLine: boolean,
  ): Promise<FmSet | null> {
    const required = newBlock ? Math.min(SET_MAX, blockSongCount(this.deps.blockSongs)) : 1;
    const take = Math.min(SET_MAX, Math.max(1, cap));
    const fresh = this.freshFor(genre, open, index);
    const vibe = genreName(genre, this.deps.language);

    // The prepared opener proved this genre when it was made. Put it on air now and
    // fill the set behind it, instead of proving the genre a second time first.
    if (
      this.prepared?.genre === genre &&
      !this.preparingOpener &&
      this.live &&
      !this.live.set &&
      !this.ended
    ) {
      const tracks: Track[] = [];
      this.claim(tracks, vibe, newBlock, genre);
      this.leadWithPrepared(tracks, genre);
      if (this.live.set) {
        await this.gatherRotation(genre, pool, fresh, listenerIds, index, tracks, 1, take);
        if (tracks.length > take) this.dropTracks(tracks.splice(take));
        return this.sealed(base, vibe, newBlock, tracks, holdLine, genre);
      }
      this.release(tracks);
    }

    if (genre !== 'other' && fresh.length < required) {
      const gathered: Track[] = [];
      const found = await this.gatherRotation(
        genre,
        pool,
        fresh,
        listenerIds,
        index,
        gathered,
        required,
        take,
      );
      if (found < required || gathered.length === 0) {
        this.dropTracks(gathered);
        return null;
      }
      return this.finishGathered(genre, gathered, base, vibe, newBlock, take, holdLine);
    }

    if (fresh.length === 0 || (newBlock && fresh.length < required)) return null;

    const tracks: Track[] = [];
    this.claim(tracks, vibe, newBlock, genre);
    this.leadWithPrepared(tracks, genre);
    const limit = this.oneSong() ? 1 : take;
    await this.loadOrdered(fresh.slice(0, limit), tracks, limit);
    if (
      genre !== 'other' &&
      tracks.length < take &&
      this.deps.catalog &&
      index &&
      !this.oneSong()
    ) {
      await this.finds.discover(pool, genre, take - tracks.length, listenerIds, index, tracks);
    }
    if (tracks.length > take) this.dropTracks(tracks.splice(take));
    if (newBlock && tracks.length < required && !this.live?.set && !this.oneSong()) {
      this.dropTracks(tracks);
      this.release(tracks);
      return null;
    }
    if (tracks.length === 0) {
      this.release(tracks);
      return null;
    }
    return this.sealed(base, vibe, newBlock, tracks, holdLine, genre);
  }

  /**
   * Kitchen songs, then finds, then the playlist, without publishing.
   * A prepared opener loads the whole attempt, so a genre of four songs is
   * not stored as the next show's opening.
   */
  private async gatherRotation(
    genre: GenreId,
    pool: FmSong[],
    fresh: readonly FmSong[],
    listenerIds: ReadonlySet<string>,
    index: GenreIndex | undefined,
    tracks: Track[],
    required: number,
    take: number,
  ): Promise<number> {
    const scan = this.preparingOpener;
    if (scan) this.rotationScan = true;
    try {
      await this.loadOrdered(fresh.slice(0, take), tracks, take);
      const gap = (): number => Math.max(0, take - tracks.length);
      if (gap() > 0 && tracks.length < required && this.deps.catalog && index) {
        await this.finds.discover(pool, genre, gap(), listenerIds, index, tracks);
      }
      if (gap() > 0 && tracks.length < required && this.deps.genreTracks) {
        await this.finds.addPlaylist(genre, pool, tracks, gap());
      }
      // Keep filling the set once it is viable, up to `take`.
      if (tracks.length >= required && gap() > 0 && this.deps.catalog && index) {
        await this.finds.discover(pool, genre, gap(), listenerIds, index, tracks);
      }
      if (tracks.length >= required && gap() > 0 && this.deps.genreTracks) {
        await this.finds.addPlaylist(genre, pool, tracks, gap());
      }
      return tracks.length;
    } finally {
      if (scan) this.rotationScan = false;
    }
  }

  /** Publish a gathered set. The opener leads when it belongs to this genre. */
  private finishGathered(
    genre: GenreId,
    found: Track[],
    base: SetBase,
    vibe: string,
    newBlock: boolean,
    cap: number,
    holdLine: boolean,
  ): FmSet | null {
    const held = found.splice(0, found.length);
    this.claim(found, vibe, newBlock, genre);
    const opener = this.prepared;
    const useOpener = Boolean(opener && !this.preparingOpener && opener.genre === genre);
    const rest = useOpener ? held.filter((track) => track.url !== opener?.track.url) : held;
    if (useOpener) this.leadWithPrepared(found, genre);
    for (const track of rest) {
      if (found.length >= cap) break;
      this.place(found, track);
    }
    if (found.length === 0) {
      this.release(found);
      return null;
    }
    return this.sealed(base, vibe, newBlock, found, holdLine, genre);
  }

  /**
   * Unaired kitchen songs for one rotation genre. `other` is songs tagged
   * that, or not tagged at all. At most one set, so five means at least five.
   */
  private freshFor(
    genre: GenreId,
    open: readonly FmSong[],
    index: GenreIndex | undefined,
  ): FmSong[] {
    if (!index) return [];
    if (genre === 'other') {
      const played = new Set(this.recent);
      const fresh = open.filter((song) => {
        if (played.has(song.key) || sidelined(song)) return false;
        const known = index.genreOf(song.key);
        return known === 'other' || known === undefined;
      });
      return sampleCrate(fresh, [], SET_MAX);
    }
    return genreSongs(open, this.recent, genre, (song) => index.genreOf(song.key));
  }

  /** Give songs back to the later planners. A failed genre must not keep them. */
  private dropTracks(tracks: Track[]): void {
    for (const track of tracks) {
      const key = this.songKeys.get(track);
      if (key) {
        this.aired.plannedKeys.delete(key);
        const at = this.recent.lastIndexOf(key);
        if (at >= 0) this.recent.splice(at, 1);
        this.songKeys.delete(track);
      }
      if (track.url) this.aired.plannedUrls.delete(track.url);
      this.about.delete(track);
      this.setOf.delete(track);
    }
    tracks.length = 0;
  }

  /** Count this set toward the block. A short set, or a full block, closes it. */
  private noteRotation(genre: GenreId, tracks: readonly Track[], wanted: number): void {
    const limit = blockSongCount(this.deps.blockSongs);
    if (this.preparingOpener) {
      this.rotation = { genre, songs: tracks.length, limit, artists: [], closed: false };
      return;
    }
    const changed = !this.rotation || this.rotation.genre !== genre || this.rotation.closed;
    if (changed) {
      this.rotation = { genre, songs: 0, limit, artists: [], closed: false };
      this.logBlock(genre, limit);
    }
    const block = this.rotation;
    if (!block) return;
    for (const track of tracks) {
      const artist = this.about.get(track)?.artist.trim();
      if (artist && !block.artists.includes(artist)) block.artists.push(artist);
    }
    block.songs += tracks.length;
    if (block.songs >= block.limit || tracks.length < wanted) {
      block.closed = true;
      this.breaks.startBreakHead();
    }
  }

  private logBlock(genre: GenreId, limit: number): void {
    const name = (id: GenreId) => genreName(id, this.deps.language);
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: ${name(genre)} for ${limit} songs (next: ${name(rotationAfter(genre))}).`,
    );
  }

  /** Load `songs` together, and append each one in list order as soon as it is ready. */
  private async loadOrdered(
    songs: readonly FmSong[],
    tracks: Track[],
    cap = SET_MAX,
  ): Promise<void> {
    // One song is enough for a prepared opener, and later misses are not searched.
    // A thin rotation genre still loads a full set, so we know it can go on air.
    if (this.oneSong()) {
      for (const song of songs) {
        if (this.ended || tracks.length >= 1 || tracks.length >= cap) return;
        const track = await this.loadSong(song).catch(() => null);
        if (track && tracks.length < cap) this.place(tracks, track);
      }
      return;
    }
    const slots: (Track | null | undefined)[] = songs.map(() => undefined);
    let cursor = 0;
    await Promise.all(
      songs.map(async (song, index) => {
        const track = await this.loadSong(song).catch(() => null);
        slots[index] = track;
        while (cursor < slots.length && slots[cursor] !== undefined) {
          const next = slots[cursor] ?? null;
          cursor += 1;
          if (next && tracks.length < cap) this.place(tracks, next);
        }
      }),
    );
  }

  /** Claude's songs, in the order it named them. The first slot is returned even when it missed. */
  private async loadPlannedOrdered(
    songs: readonly PlannedSong[],
    crate: FmSong[],
    pool: FmSong[],
    airedNames: BlockedSongs,
    setNumber: number,
    tracks: Track[],
  ): Promise<Track | null> {
    const slots: (Track | null | undefined)[] = songs.map(() => undefined);
    let cursor = 0;
    let first: Track | null = null;
    await Promise.all(
      songs.map(async (song, index) => {
        let track: Track | null = null;
        if (!(setNumber === 1 && song.crate === null)) {
          track = await this.loadPlanned(song, crate, pool, airedNames).catch((error: unknown) => {
            this.deps.logger.warn(`Kitchen FM could not load "${song.title}":`, error);
            return null;
          });
        }
        slots[index] = track;
        while (cursor < slots.length && slots[cursor] !== undefined) {
          const next = slots[cursor] ?? null;
          cursor += 1;
          if (cursor === 1) first = next;
          if (next && tracks.length < SET_MAX) this.place(tracks, next);
        }
      }),
    );
    return first;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A crate song by its number, a kitchen song Claude named, or a new find off YouTube. */
  private async loadPlanned(
    song: PlannedSong,
    crate: FmSong[],
    pool: FmSong[],
    airedNames: BlockedSongs,
  ): Promise<Track | null> {
    if (song.crate !== null) {
      const kitchen = crate[song.crate - 1];
      if (!kitchen || this.aired.plannedThisShow(kitchen)) return null;
      return this.loadSong(kitchen);
    }
    // A crate-less name that already aired is not loaded, even when the kitchen has it.
    if (airedNames.matches(song)) return null;
    const known = pool.find((kitchen) => isSameSong(song, { title: kitchen.label }));
    if (known) return this.loadSong(known);
    if (this.played.some((label) => isSameSong(song, { title: label }))) return null;

    const title = plainTitle(song.title);
    const query = song.artist ? `${song.artist} - ${title}` : title;
    const hit = await this.deps.source.youtube.searchOne(query, NEW_FIND);
    if (!hit || !songFits(hit.durationSec) || !isSameSong(song, hit)) {
      this.aired.noteDead(song.artist, song.title);
      this.deps.logger.info(`Kitchen FM: no YouTube match for the new find "${query}".`);
      return null;
    }
    if (this.aired.plannedUrls.has(hit.url) || this.aired.airedNow.urls.has(hit.url)) {
      this.aired.noteDead(song.artist, song.title);
      return null;
    }
    hit.stationPick = true;
    this.about.set(hit, { artist: song.artist, title: song.title, by: null, how: 'new' });
    this.rememberFind(hit);
    return hit;
  }

  /** A 🔥 records this hit as a play, and `knows()` reads that play back with this key. */
  private rememberFind(hit: Track): void {
    const key = songFromTrack(hit, { kind: 'play' }).key;
    this.remember(hit, key);
    this.aired.markPlanned(key, hit.url);
  }

  private remember(track: Track, key: string): void {
    if (key && key !== '|') this.songKeys.set(track, key);
  }

  /** Top a short set up toward five songs from what has not been planned yet. */
  private async fill(tracks: Track[], pool: FmSong[]): Promise<void> {
    let misses = 0;
    while (tracks.length < SET_MAX && misses < FILL_TRIES) {
      const open = pool.filter((song) => !this.aired.plannedThisShow(song));
      const song = open.length > 0 ? pickSong(open, this.recent) : null;
      if (!song || this.aired.plannedThisShow(song)) return;
      const before = tracks.length;
      const track = await this.loadSong(song);
      if (track) this.place(tracks, track);
      if (tracks.length === before) misses += 1;
    }
  }

  /**
   * Songs that started outside a planned set (a request, or whatever was already
   * playing) stay out for the rest of the show. A station pick is already
   * marked: `loadSong` recorded it when the set was built.
   */
  private noteJustPlayed(pool: readonly FmSong[]): void {
    if (this.justPlayed.length === 0) return;
    const tracks = this.justPlayed.splice(0);
    for (const track of tracks) {
      const song = pool.find((item) => playedMatches(item, track));
      const named = song ?? songFromTrack(track, { kind: 'play' });
      this.aired.markPlanned(song?.key ?? named.key, track.url);
      if (song && !this.recent.includes(song.key)) this.recent.push(song.key);
      const label = named.artist ? `${named.artist} – ${named.title}` : named.title;
      if (label.trim()) this.played.push(label);
    }
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
  }

  /** A played song plays from its link; a catch is looked up on YouTube first. */
  private async loadSong(song: FmSong): Promise<Track | null> {
    this.recent.push(song.key);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    const userId = song.from.userId;
    const by = userId ? await this.nameOf(userId) : null;
    const about: OpenerSong = {
      artist: song.artist,
      title: song.title,
      by,
      how: song.from.kind === 'catch' ? 'catch' : 'play',
    };
    if (song.url) {
      const track: Track = {
        title: song.videoTitle ?? song.label,
        url: song.url,
        durationSec: song.durationSec,
        thumbnail: song.thumbnail,
        uploader: song.uploader,
        requestedBy: by ?? 'Kitchen FM',
        requestedById: userId,
        source: 'youtube',
        stationPick: true,
      };
      this.about.set(track, about);
      this.remember(track, song.key);
      this.aired.markPlanned(song.key, song.url);
      return track;
    }
    const hit = await this.deps.source.youtube
      .searchOne(song.query, by ?? 'Kitchen FM')
      .catch((error: unknown) => {
        this.deps.logger.warn(`Kitchen FM could not look up "${song.label}":`, error);
        return null;
      });
    if (!hit || !songFits(hit.durationSec)) return null;
    hit.requestedById = userId;
    hit.stationPick = true;
    hit.thumbnail ??= song.thumbnail;
    this.about.set(hit, about);
    this.remember(hit, song.key);
    this.aired.markPlanned(song.key, hit.url);
    return hit;
  }

  /** Display names of who brought each song, by user id. */
  private async namesOf(songs: FmSong[]): Promise<Map<string, string>> {
    const ids = [...new Set(songs.flatMap((song) => (song.from.userId ? [song.from.userId] : [])))];
    const names = await Promise.all(ids.map((id) => this.nameOf(id)));
    return new Map(ids.flatMap((id, i) => (names[i] ? [[id, names[i]]] : [])));
  }

  private async nameOf(userId: string): Promise<string | null> {
    const member =
      this.deps.guild.members.cache.get(userId) ??
      (await this.deps.guild.members.fetch(userId).catch(() => null));
    return member?.displayName ?? null;
  }
}
