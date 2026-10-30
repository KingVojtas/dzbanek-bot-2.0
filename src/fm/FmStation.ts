import type { Guild, GuildMember } from 'discord.js';
import type { Logger } from '../core/logger';
import type { PlayerStation, StationIntro, Track } from '../core/types';
import { zonedParts } from '../kitchen/time';
import type { CompositeTrackSource } from '../music/sources';
import { getStation } from '../radio/station';
import { songFromTrack } from '../quiz/songs';
import type { AiredSong } from '../quiz/stores';
import type { FmCatalog } from './catalog';
import { DedicationQueue, dedicationText, joinIntro, type WaitingDedication } from './dedications';
import type { GenreId, GenreIndex } from './genres';
import { artistKey, genreName } from './genres';
import {
  joinNames,
  lineDaypart,
  lineTime,
  loadLineBook,
  momentsFor,
  songPhrase,
  type LineBook,
  type LineSlots,
  type Moment,
} from './lines';
import { pcmLoudness, type DjVoice } from './voice';
import type { DjWriter } from './writer';
import {
  CRATE_SIZE,
  SET_MAX,
  SET_MIN,
  isSameSong,
  pickSong,
  prepareBlocked,
  relativeDay,
  sampleCrate,
  sidelined,
  songFits,
  templateOpener,
  themeName,
  themedSet,
  type BlockedSongs,
  type DjLanguage,
  type FmSong,
  type OpenerSong,
  type PlannedSong,
  type Theme,
} from './script';
import {
  blockProfile,
  findAllowance,
  genreSongs,
  kitchenSlots,
  nextGenre,
  pickDiscoverTrack,
  seedArtistIds,
  tasteProfile,
} from './taste';

/** A set still waiting behind requests after this long is planned again: its line names the time. */
const STALE_MS = 20 * 60_000;
/** Tries to top up a set whose songs would not load. */
const FILL_TRIES = 4;
/** The show's first line is synthesized cold, so the player may wait this long. */
const OPENER_WAIT_MS = 25_000;
/** Related-artist and top-track calls one mixed set may spend on Deezer. */
const DISCOVER_DEEZER_CALLS = 8;
/** YouTube searches one mixed set may spend looking for a new find. */
const DISCOVER_YOUTUBE_CALLS = 4;
/** Fewer unaired kitchen songs than this: one set of them, then sets of new finds. */
const SMALL_KITCHEN = 10;
/** What Claude hears of this show: its last vibes and songs. */
const VIBES_SHOWN = 6;
const PLAYED_SHOWN = 30;
/** Shown under "Brought in by" for a song nobody in the kitchen brought. */
const NEW_FIND = '🎙️ Kitchen FM · new find';

/** `played` stores "Artist – Title". Split it back so a find is not that song again. */
function splitPlayed(label: string): { artist: string; title: string } {
  const parts = label.split(/\s+[–—-]\s+/);
  if (parts.length >= 2 && parts[0] && parts.slice(1).join(' - ')) {
    return { artist: parts[0], title: parts.slice(1).join(' - ') };
  }
  return { artist: '', title: label };
}

/** A pool song is this track: by its link, or by its title when the song has none. */
function playedMatches(song: FmSong, track: Track): boolean {
  if (song.url) return song.url === track.url;
  return song.key === songFromTrack(track, { kind: 'play' }).key;
}

/** Keys, links, and the latest play of everything `aired()` returned for one set. */
interface AiredMemory {
  keys: Set<string>;
  urls: Set<string>;
  lastByKey: Map<string, number>;
  lastByUrl: Map<string, number>;
  rows: readonly AiredSong[];
}

function emptyAired(): AiredMemory {
  return { keys: new Set(), urls: new Set(), lastByKey: new Map(), lastByUrl: new Map(), rows: [] };
}

/** The latest `playedAt` wins when the same song aired more than once. */
function indexAired(rows: readonly AiredSong[]): AiredMemory {
  const memory = emptyAired();
  memory.rows = rows;
  for (const row of rows) {
    const at = row.playedAt.getTime();
    if (row.songKey) {
      memory.keys.add(row.songKey);
      const prev = memory.lastByKey.get(row.songKey);
      if (prev === undefined || at > prev) memory.lastByKey.set(row.songKey, at);
    }
    if (row.url) {
      memory.urls.add(row.url);
      const prev = memory.lastByUrl.get(row.url);
      if (prev === undefined || at > prev) memory.lastByUrl.set(row.url, at);
    }
  }
  return memory;
}

export interface FmStationDeps {
  guild: Guild;
  /** People (not bots) in the bot's voice channel right now. */
  listeners: () => GuildMember[];
  /** The kitchen's songs, read fresh for every set. */
  pool: () => Promise<FmSong[]>;
  source: CompositeTrackSource;
  writer: DjWriter;
  voice: DjVoice;
  language: DjLanguage;
  /** New finds a set may hold, songs the kitchen never played. */
  discover: number;
  /** Sets in a genre block after the opening set. The first block of a show is one set. */
  blockSets?: number;
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
  /** The DJ's line book. Loaded for `language` when omitted. */
  lines?: LineBook | null;
  /** Clock for the block and for a set going stale. */
  now?: () => number;
  timezone: string;
  logger: Logger;
}

/** A few songs that share a vibe. The DJ talks before the first one only. */
interface FmSet {
  vibe: string;
  line: string;
  tracks: Track[];
  /** The next of `tracks` to hand out. */
  next: number;
  plannedAt: number;
  /** The show's first set. Its clip is synthesized before anything is playing. */
  opener?: boolean;
}

type SetBase = { hour: number; minute: number; set: number; newcomers: string[] };

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
  /** Set lines in flight or ready. A clip that came back empty is dropped. */
  private readonly intros = new WeakMap<FmSet, Promise<StationIntro | null>>();
  private readonly dedications = new DedicationQueue();
  /** Handed over in `starting`, so an early `intro` cannot spend it. */
  private readonly dedicationOf = new WeakMap<Track, WaitingDedication>();
  /** Dedication clips in flight or ready. A clip that came back empty is dropped. */
  private readonly dedicationClips = new WeakMap<WaitingDedication, Promise<Buffer | null>>();
  /** Joined intro. Dropped when a part that should have audio came back empty. */
  private readonly combined = new WeakMap<Track, Promise<StationIntro | null>>();
  private lastTheme: Theme['kind'] | undefined;
  /** Who was listening when the current set started. */
  private wasListening = new Set<string>();
  /** Requests, and the song already on when the station started. Pushed into `recent` at plan time. */
  private readonly justPlayed: Track[] = [];
  /** Keys and URLs this show has already planned. Uncapped, so nothing is planned twice. */
  private readonly plannedKeys = new Set<string>();
  private readonly plannedUrls = new Set<string>();
  /** Find queries YouTube could not match this show. A thrown search is not one of these. */
  private readonly deadEnds: { artist: string; title: string }[] = [];
  /** Related artists, one Deezer fetch per artist for the whole show. */
  private readonly relatedCache = new Map<number, { id: number; name: string }[]>();
  /** Top tracks, one Deezer fetch per artist for the whole show. */
  private readonly topCache = new Map<
    number,
    { title: string; artist: string; durationSec: number }[]
  >();
  /** Artists whose top list has nothing left to pick this show. */
  private readonly exhaustedArtists = new Set<number>();
  /** What `aired()` returned for the set being planned. */
  private airedNow: AiredMemory = emptyAired();
  private ended = false;
  /** The genre block on air: how many sets it should hold, and how many are planned. */
  private block: { genre: GenreId; sets: number; limit: number } | null = null;
  private readonly blockHistory: GenreId[] = [];
  /** Line indexes already said this show, so a line is not repeated while others remain. */
  private readonly usedLines = new Map<Moment, Set<number>>();
  private readonly lineBook: LineBook | null;

  constructor(
    private readonly deps: FmStationDeps,
    private readonly onEnd: () => void,
  ) {
    this.lineBook = deps.lines === undefined ? loadLineBook(deps.language) : deps.lines;
  }

  upNext(): Promise<Track | null> {
    if (this.ended) return Promise.resolve(null);
    if (this.pending && this.now() - this.pending.plannedAt > STALE_MS) {
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
    const text = dedicationText(this.lineBook?.of('dedication') ?? [], input, this.deps.language);
    const dedication: WaitingDedication = { ...input, text, speech: Promise.resolve(null) };
    this.dedications.add(dedication);
    // Starts now, so playback is not waiting on a cold call later.
    this.speakDedication(dedication);
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
    this.handDedication(track);
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
    this.combined.delete(track);
    const song = dedication.song.trim();
    if (song && dedication.text.includes(song)) {
      const text = dedicationText(
        this.lineBook?.of('dedication') ?? [],
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
      this.speakDedication(again);
      return;
    }
    const again: WaitingDedication = { ...dedication, track: null };
    const existing = this.dedicationClips.get(dedication);
    if (existing) this.dedicationClips.set(again, existing);
    this.dedicationClips.delete(dedication);
    if (existing) again.speech = existing;
    this.dedications.returnFront(again);
  }

  intro(track: Track): Promise<StationIntro | null> {
    if (this.ended) return Promise.resolve(null);
    const dedication = this.dedicationOf.get(track);
    const setLine = this.setIntro(track);
    if (!dedication) return setLine ?? Promise.resolve(null);
    const pending = this.combined.get(track);
    if (pending) return pending;
    const next = this.withDedication(track, dedication, setLine);
    this.combined.set(track, next);
    return next;
  }

  /**
   * The opener is synthesized cold, so it may wait longer. A dedication's clip
   * starts when it is accepted, and the same longer wait covers one that was
   * only just accepted. Every other intro uses the player's usual wait.
   */
  introWaitMs(track: Track): number | undefined {
    if (this.dedicationOf.get(track)) return OPENER_WAIT_MS;
    const set = this.setOf.get(track);
    if (set?.opener && set.tracks[0] === track) return OPENER_WAIT_MS;
    return undefined;
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
    this.dedications.clear();
    this.onEnd();
  }

  /** Bind the dedication this song should read. An early `intro` has not called this. */
  private handDedication(track: Track): void {
    if (this.ended || this.dedicationOf.has(track)) return;
    const dedication = this.dedications.take(track);
    if (dedication) this.dedicationOf.set(track, dedication);
  }

  /**
   * The set line for the first song of a set. Null for any other song.
   * Callers that ask together share one synthesis. A clip that came back
   * empty is forgotten, so the next `intro` tries again before the song.
   */
  private setIntro(track: Track): Promise<StationIntro | null> | null {
    const set = this.setOf.get(track);
    if (!set || set.tracks[0] !== track) return null;
    const pending = this.intros.get(set);
    if (pending) return pending;
    const next = this.deps.voice
      .speak(set.line)
      .then((pcm) => {
        if (!pcm?.length) this.intros.delete(set);
        return { text: set.line, pcm };
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM intro failed:', error);
        this.intros.delete(set);
        return { text: set.line, pcm: null };
      });
    this.intros.set(set, next);
    return next;
  }

  /**
   * The dedication clip. A failure is dropped, so the next `intro` tries
   * again instead of replaying the empty buffer. Two callers share one call.
   */
  private speakDedication(dedication: WaitingDedication): Promise<Buffer | null> {
    const cached = this.dedicationClips.get(dedication);
    if (cached) return cached;
    const pending = this.deps.voice
      .speak(dedication.text)
      .then((pcm) => {
        if (!pcm?.length) this.dedicationClips.delete(dedication);
        return pcm;
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM dedication failed:', error);
        this.dedicationClips.delete(dedication);
        return null;
      });
    this.dedicationClips.set(dedication, pending);
    dedication.speech = pending;
    return pending;
  }

  /** Dedication first, a short gap, then the set line. The card shows both texts. */
  private async withDedication(
    track: Track,
    dedication: WaitingDedication,
    setLine: Promise<StationIntro | null> | null,
  ): Promise<StationIntro> {
    const [spoken, set] = await Promise.all([
      this.speakDedication(dedication),
      setLine ?? Promise.resolve(null),
    ]);
    const text = [dedication.text, set?.text].filter(Boolean).join(' ');
    const pcm = joinIntro(spoken, set?.pcm ?? null);
    // A missing part is not final: the next intro tries that part again.
    if (!spoken?.length || (setLine && !set?.pcm?.length)) this.combined.delete(track);
    return { text, pcm };
  }

  private async peek(): Promise<Track | null> {
    const queued = this.queued();
    if (queued) return queued;
    this.pending = await this.plan();
    return this.pending?.tracks[0] ?? null;
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
    await this.readAired();
    const unaired = pool.filter((song) => !this.taken(song));
    const clock = zonedParts(this.deps.timezone);
    const number = this.vibes.length + 1;
    if (number === 1) {
      this.deps.logger.info(
        `Kitchen FM in ${this.deps.guild.name}: ${this.airedNow.keys.size} songs already aired, ` +
          `${unaired.length} of ${pool.length} kitchen songs not aired yet.`,
      );
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

    // A thin unaired kitchen, including set 1, is new finds plus whatever is left.
    // A small one plays its own songs once, then finds. Anything that throws falls through.
    const thin = unaired.length < SET_MIN;
    const small = unaired.length < SMALL_KITCHEN;
    let triedFinds = false;
    const findsFailed = (error: unknown): null => {
      this.deps.logger.warn('Kitchen FM could not plan a set of new finds:', error);
      return null;
    };
    let set: FmSet | null =
      thin || (number > 1 && small)
        ? await this.planFinds(pool, unaired, base, listeners).catch(findsFailed)
        : null;
    if (thin || (number > 1 && small)) triedFinds = true;
    set ??= await this.planBlocks(pool, unaired, base, listeners).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM could not plan a genre set:', error);
      return null;
    });
    set ??= await this.planWithClaude(unaired, base, time, listeners);
    set ??= await this.planThemed(pool, unaired, base, listeners);
    if (!set && !triedFinds && !this.ended) {
      set = await this.planFinds(pool, unaired, base, listeners).catch(findsFailed);
    }
    if (!set && !this.ended) set = await this.planOldest(pool, base);
    if (!set || this.ended) return null;
    for (const track of set.tracks) {
      this.setOf.set(track, set);
      const song = this.about.get(track);
      if (song) this.played.push(song.artist ? `${song.artist} – ${song.title}` : song.title);
    }
    if (this.played.length > 200) this.played.splice(0, this.played.length - 200);
    const finds = set.tracks.filter((track) => this.about.get(track)?.how === 'new').length;
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: set ${number}, "${set.vibe}", ` +
        `${set.tracks.length} songs${finds ? ` (${finds} new)` : ''}: "${set.line}"`,
    );
    set.opener = number === 1;
    this.cueVoice(set);
    return set;
  }

  /** Start the clip as soon as the set exists, and say how it came out. */
  private cueVoice(set: FmSet): void {
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
    const open = unaired.filter((song) => !this.plannedThisShow(song));
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
        playedThisShow: this.playedForClaude(),
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

    const airedNames = this.airedNames();
    const loaded = await Promise.all(
      plan.songs.map((song) => {
        if (base.set === 1 && song.crate === null) return null;
        return this.loadPlanned(song, crateSongs, open, airedNames).catch((error: unknown) => {
          this.deps.logger.warn(`Kitchen FM could not load "${song.title}":`, error);
          return null;
        });
      }),
    );
    // A new find can turn out to be a kitchen song already in the set.
    const tracks = loaded.filter(
      (track, i): track is Track =>
        track !== null && loaded.findIndex((other) => other?.url === track.url) === i,
    );
    await this.fill(tracks, open);
    if (tracks.length === 0) return null;
    const line =
      loaded[0] && plan.line ? plan.line : this.speak(base, plan.vibe, tracks[0]!, false);
    return { vibe: plan.vibe, line, tracks, next: 0, plannedAt: this.now() };
  }

  private async planThemed(
    pool: FmSong[],
    unaired: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const listenerMap = new Map(listeners.map((member) => [member.id, member.displayName]));
    const fresh = unaired.filter((song) => !this.plannedThisShow(song));
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
    const loaded = await Promise.all(chosen.map((song) => this.loadSong(song)));
    const tracks = loaded.filter((track): track is Track => track !== null);

    const index = this.deps.genres;
    if (allowance > 0 && this.deps.catalog && index) {
      const listenerIds = new Set(listeners.map((member) => member.id));
      const discovered = await this.discover(pool, null, allowance, listenerIds, index);
      for (const track of discovered) {
        if (tracks.length >= SET_MAX) break;
        if (!tracks.some((other) => other.url === track.url)) tracks.push(track);
      }
    }
    await this.fill(tracks, fresh);
    if (tracks.length === 0 || !tracks[0]) return null;
    const theme = picked?.theme ?? { kind: 'mix' as const };
    this.lastTheme = theme.kind;
    const vibe = themeName(theme, this.deps.language);
    return {
      vibe,
      line: this.speak(base, vibe, tracks[0], false),
      tracks,
      next: 0,
      plannedAt: this.now(),
    };
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
    const open = unaired.filter((song) => !this.plannedThisShow(song));
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

    const tracks = await this.loadGenreSet(
      picked,
      pool,
      open,
      genre,
      base.set === 1 ? 0 : finds,
      listenerIds,
      index,
    );
    if (tracks.length === 0 || !tracks[0]) return null;
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
    const vibe = genreName(genre, this.deps.language);
    return {
      vibe,
      line: this.speak(base, vibe, tracks[0], fresh),
      tracks,
      next: 0,
      plannedAt: now,
    };
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
    const open = unaired.filter((song) => !this.plannedThisShow(song));
    const reserve = open.length < SET_MIN ? Math.min(open.length, SET_MAX) : 0;
    const discovered = await this.discover(pool, null, SET_MAX - reserve, listenerIds, index);
    const tracks = [...discovered];
    if (tracks.length < SET_MAX) await this.fill(tracks, open);
    if (tracks.length === 0 || !tracks[0]) return null;
    const vibe = this.deps.language === 'cs' ? 'podobní interpreti' : 'similar artists';
    return {
      vibe,
      line: this.speak(base, vibe, tracks[0], false),
      tracks,
      next: 0,
      plannedAt: this.now(),
    };
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
    const waiting = list.filter((song) => !this.plannedThisShow(song));
    const source = waiting.length > 0 ? waiting : list.length > 0 ? list : pool;
    const ordered = [...source].sort(
      (a, b) => this.lastAiredAt(a) - this.lastAiredAt(b) || a.key.localeCompare(b.key),
    );
    const tracks: Track[] = [];
    for (const song of ordered) {
      if (tracks.length >= SET_MAX) break;
      const track = await this.loadSong(song);
      if (track && !tracks.some((other) => other.url === track.url)) tracks.push(track);
    }
    if (!tracks[0]) return null;
    const vibe = themeName({ kind: 'throwbacks' }, this.deps.language);
    return {
      vibe,
      line: this.speak(base, vibe, tracks[0], false),
      tracks,
      next: 0,
      plannedAt: this.now(),
    };
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
  ): Promise<Track[]> {
    const kitchen = picked.slice(0, kitchenSlots(picked.length, finds));
    const loaded = await Promise.all(kitchen.map((song) => this.loadSong(song)));
    const tracks = loaded.filter((track): track is Track => track !== null);
    if (finds > 0 && this.deps.catalog) {
      const discovered = await this.discover(pool, genre, finds, listenerIds, index);
      for (const track of discovered) {
        if (tracks.length >= SET_MAX) break;
        if (!tracks.some((other) => other.url === track.url)) tracks.push(track);
      }
    }
    // Top up only with unaired songs of the same genre: a short set beats one under the wrong name.
    const same = unaired.filter(
      (song) => index.genreOf(song.key) === genre && !this.plannedThisShow(song),
    );
    await this.fill(tracks, same);
    return tracks;
  }

  /**
   * Related artists the kitchen has not played, then one of their top tracks
   * from YouTube. When that ring runs out, the next ring, then the kitchen
   * artists' own unplayed tops. A cache hit is not a Deezer call. A finds-only
   * set (more than 3) may look further than a mixed one.
   */
  private async discover(
    pool: FmSong[],
    genre: GenreId | null,
    allowance: number,
    listenerIds: ReadonlySet<string>,
    index: GenreIndex,
  ): Promise<Track[]> {
    const catalog = this.deps.catalog;
    if (!catalog || allowance <= 0) return [];
    const kitchenArtists = new Set(pool.map((song) => artistKey(song.artist)).filter(Boolean));
    const extra = (await this.deps.findBlocks?.()) ?? [];
    const blocked = prepareBlocked([
      ...pool.map((song) => ({ artist: song.artist, title: song.title })),
      ...this.played.map(splitPlayed),
      ...this.deadEnds,
      ...extra,
      ...this.airedNow.rows.map((row) => ({ artist: row.artist, title: row.title })),
    ]);
    // A genre block seeds from that genre. A themed set seeds from the whole kitchen.
    const seeded = genre === null ? pool : pool.filter((song) => index.genreOf(song.key) === genre);
    const seeds = seedArtistIds(
      seeded.map((song) => ({ from: song.from, deezerArtistId: index.artistId(song.key) })),
      listenerIds,
    );
    const found: Track[] = [];
    const budget = { deezer: 0, youtube: 0 };
    const deezerCap = allowance > 3 ? allowance * 4 + 4 : DISCOVER_DEEZER_CALLS;
    const youtubeCap = allowance > 3 ? allowance * 2 : DISCOVER_YOUTUBE_CALLS;
    const room = (): boolean =>
      found.length < allowance && budget.deezer < deezerCap && budget.youtube < youtubeCap;
    const seen = new Set<number>(seeds);
    let frontier = [...seeds];
    while (frontier.length > 0 && room()) {
      const next: number[] = [];
      for (const id of frontier) {
        if (!room()) break;
        const related = await this.cachedRelated(id, budget, deezerCap);
        for (const artist of related) {
          if (!room()) break;
          if (kitchenArtists.has(artistKey(artist.name))) continue;
          if (seen.has(artist.id)) continue;
          seen.add(artist.id);
          next.push(artist.id);
          await this.takeFrom(artist.id, blocked, budget, deezerCap, youtubeCap, found, allowance);
        }
      }
      frontier = next;
    }
    // Still short: more from the kitchen's own artists, songs it has not played.
    for (const seedId of seeds) {
      if (!room()) break;
      await this.takeFrom(seedId, blocked, budget, deezerCap, youtubeCap, found, allowance);
    }
    return found;
  }

  /** Related artists for `id`. A hit in this show's cache is not a Deezer call. */
  private async cachedRelated(
    id: number,
    budget: { deezer: number },
    cap: number,
  ): Promise<{ id: number; name: string }[]> {
    const cached = this.relatedCache.get(id);
    if (cached) return cached;
    const catalog = this.deps.catalog;
    if (!catalog || budget.deezer >= cap) return [];
    budget.deezer += 1;
    const list = await catalog.relatedArtists(id);
    // A failed call is also empty: ask again next set.
    if (list.length > 0) this.relatedCache.set(id, list);
    return list;
  }

  /**
   * Top tracks for `id`. Null when the artist is exhausted or the cap is spent,
   * without another Deezer call. A cached list is free.
   */
  private async cachedTops(
    id: number,
    budget: { deezer: number },
    cap: number,
  ): Promise<{ title: string; artist: string; durationSec: number }[] | null> {
    if (this.exhaustedArtists.has(id)) return null;
    const cached = this.topCache.get(id);
    if (cached) return cached;
    const catalog = this.deps.catalog;
    if (!catalog || budget.deezer >= cap) return null;
    budget.deezer += 1;
    const list = await catalog.topTracks(id);
    // A failed call is also empty: ask again next set rather than retire the artist.
    if (list.length === 0) return null;
    this.topCache.set(id, list);
    return list;
  }

  /**
   * One playable top track from `artistId`, or nothing. A query YouTube cannot
   * match is blocked for the rest of the show. A search that throws is not.
   */
  private async takeFrom(
    artistId: number,
    blocked: BlockedSongs,
    budget: { deezer: number; youtube: number },
    deezerCap: number,
    youtubeCap: number,
    found: Track[],
    allowance: number,
  ): Promise<void> {
    if (this.exhaustedArtists.has(artistId)) return;
    if (found.length >= allowance || budget.youtube >= youtubeCap) return;
    const tops = await this.cachedTops(artistId, budget, deezerCap);
    if (!tops) return;
    while (found.length < allowance && budget.youtube < youtubeCap) {
      const pick = pickDiscoverTrack(tops, blocked, Math.random);
      if (!pick) {
        this.exhaustedArtists.add(artistId);
        return;
      }
      const query = `${pick.artist} - ${pick.title}`;
      budget.youtube += 1;
      let threw = false;
      const hit = await this.deps.source.youtube
        .searchOne(query, NEW_FIND)
        .catch((error: unknown) => {
          threw = true;
          this.deps.logger.warn(`Kitchen FM: YouTube search failed for "${query}":`, error);
          return null;
        });
      if (threw) return;
      if (!hit || !songFits(hit.durationSec) || !isSameSong(pick, hit)) {
        this.noteDead(pick.artist, pick.title);
        blocked.add({ artist: pick.artist, title: pick.title });
        this.deps.logger.info(`Kitchen FM: no YouTube match for the new find "${query}".`);
        continue;
      }
      if (this.plannedUrls.has(hit.url) || this.airedNow.urls.has(hit.url)) {
        this.noteDead(pick.artist, pick.title);
        blocked.add({ artist: pick.artist, title: pick.title });
        this.deps.logger.info(`Kitchen FM: "${query}" already aired.`);
        continue;
      }
      this.deps.logger.info(`Kitchen FM: new find "${pick.artist} - ${pick.title}".`);
      hit.stationPick = true;
      this.about.set(hit, { artist: pick.artist, title: pick.title, by: null, how: 'new' });
      this.rememberFind(hit);
      blocked.add({ artist: pick.artist, title: pick.title });
      found.push(hit);
      return;
    }
  }

  /** The line book, then the short built-in line when the book has nothing. */
  private speak(base: SetBase, vibe: string, first: Track, newBlock: boolean): string {
    const about = this.about.get(first) ?? {
      artist: '',
      title: first.title,
      by: null,
      how: 'play' as const,
    };
    const line = this.lineBook?.speak(
      momentsFor({
        set: base.set,
        newBlock,
        hour: base.hour,
        newcomers: base.newcomers,
        how: about.how,
        by: about.by,
      }),
      this.slots(base, vibe, about),
      this.usedLines,
    );
    if (line) return line;
    return templateOpener({
      language: this.deps.language,
      server: this.deps.guild.name,
      ...base,
      vibe,
      first: about,
    });
  }

  private slots(base: SetBase, genre: string, song: OpenerSong): LineSlots {
    const language = this.deps.language;
    return {
      server: this.deps.guild.name,
      time: lineTime(base.hour, base.minute, language),
      daypart: lineDaypart(base.hour, language),
      genre,
      song: songPhrase(song.artist, song.title, language),
      artist: song.artist,
      by: song.by ?? '',
      names: joinNames(base.newcomers, language),
      station: 'Kitchen FM',
      from: '',
      to: '',
      message: '',
    };
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
      if (!kitchen || this.plannedThisShow(kitchen)) return null;
      return this.loadSong(kitchen);
    }
    // A crate-less name that already aired is not loaded, even when the kitchen has it.
    if (airedNames.matches(song)) return null;
    const known = pool.find((kitchen) => isSameSong(song, { title: kitchen.label }));
    if (known) return this.loadSong(known);
    if (this.played.some((label) => isSameSong(song, { title: label }))) return null;

    const query = song.artist ? `${song.artist} - ${song.title}` : song.title;
    const hit = await this.deps.source.youtube.searchOne(query, NEW_FIND);
    if (!hit || !songFits(hit.durationSec) || !isSameSong(song, hit)) {
      this.noteDead(song.artist, song.title);
      this.deps.logger.info(`Kitchen FM: no YouTube match for the new find "${query}".`);
      return null;
    }
    if (this.plannedUrls.has(hit.url) || this.airedNow.urls.has(hit.url)) {
      this.noteDead(song.artist, song.title);
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
    this.markPlanned(key, hit.url);
  }

  private remember(track: Track, key: string): void {
    if (key && key !== '|') this.songKeys.set(track, key);
  }

  /** Top a short set up toward five songs from what has not been planned yet. */
  private async fill(tracks: Track[], pool: FmSong[]): Promise<void> {
    let misses = 0;
    while (tracks.length < SET_MAX && misses < FILL_TRIES) {
      const open = pool.filter((song) => !this.plannedThisShow(song));
      const song = open.length > 0 ? pickSong(open, this.recent) : null;
      if (!song || this.plannedThisShow(song)) return;
      const before = tracks.length;
      const track = await this.loadSong(song);
      if (track && !tracks.some((other) => other.url === track.url)) tracks.push(track);
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
      this.markPlanned(song?.key ?? named.key, track.url);
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
      this.markPlanned(song.key, song.url);
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
    this.markPlanned(song.key, hit.url);
    return hit;
  }

  /** `fm` and `find` rows, plus today's plays. A failed read leaves the show with nothing aired. */
  private async readAired(): Promise<void> {
    const read = this.deps.aired;
    if (!read) {
      this.airedNow = emptyAired();
      return;
    }
    try {
      this.airedNow = indexAired(await read());
    } catch (error: unknown) {
      this.deps.logger.warn('Kitchen FM could not read what it already aired:', error);
      this.airedNow = emptyAired();
    }
  }

  /** Aired already, or planned earlier in this show. */
  private taken(song: FmSong): boolean {
    return this.plannedThisShow(song) || this.airedKitchen(song);
  }

  /** Planned earlier in this show, by pool key or link. */
  private plannedThisShow(song: FmSong): boolean {
    if (this.plannedKeys.has(song.key)) return true;
    return Boolean(song.url && this.plannedUrls.has(song.url));
  }

  /** A kitchen song whose key or link is in the aired log. */
  private airedKitchen(song: FmSong): boolean {
    if (this.airedNow.keys.has(song.key)) return true;
    return Boolean(song.url && this.airedNow.urls.has(song.url));
  }

  /** Latest time this kitchen song aired. Never aired is 0, so it sorts first. */
  private lastAiredAt(song: FmSong): number {
    const byKey = this.airedNow.lastByKey.get(song.key) ?? 0;
    const byUrl = song.url ? (this.airedNow.lastByUrl.get(song.url) ?? 0) : 0;
    return Math.max(byKey, byUrl);
  }

  private markPlanned(key: string | undefined, url: string | undefined): void {
    if (key && key !== '|') this.plannedKeys.add(key);
    if (url) this.plannedUrls.add(url);
  }

  /** Remember a find query that YouTube could not match. A thrown search does not come here. */
  private noteDead(artist: string, title: string): void {
    if (this.deadEnds.some((song) => song.artist === artist && song.title === title)) return;
    this.deadEnds.push({ artist, title });
  }

  /** Aired songs and dead finds, so Claude's crate-less names can be refused. */
  private airedNames(): BlockedSongs {
    return prepareBlocked([
      ...this.airedNow.rows.map((row) => ({ artist: row.artist, title: row.title })),
      ...this.deadEnds,
    ]);
  }

  /**
   * What Claude is told already played. This show first, then the most recent
   * aired songs, never more than `PLAYED_SHOWN`.
   */
  private playedForClaude(): string[] {
    const own = this.played.slice(-PLAYED_SHOWN);
    if (own.length >= PLAYED_SHOWN) return own;
    const seen = new Set(own.map((label) => label.toLowerCase()));
    const labels = [...own];
    const recent = [...this.airedNow.rows].sort(
      (a, b) => b.playedAt.getTime() - a.playedAt.getTime(),
    );
    for (const row of recent) {
      if (labels.length >= PLAYED_SHOWN) break;
      const label = row.artist ? `${row.artist} – ${row.title}` : row.title;
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      labels.push(label);
    }
    return labels;
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
