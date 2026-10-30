import type { Guild, GuildMember } from 'discord.js';
import type { Logger } from '../core/logger';
import type { PlayerStation, StationIntro, Track } from '../core/types';
import { zonedParts } from '../kitchen/time';
import type { CompositeTrackSource } from '../music/sources';
import { getStation } from '../radio/station';
import { songFromTrack } from '../quiz/songs';
import type { AiredSong } from '../quiz/stores';
import type { DeezerTop, FmCatalog } from './catalog';
import { pcmSeconds } from '../music/intro-wait';
import {
  BREAK_SPEAK_MS,
  BREAK_TAIL_SEC,
  applyBedAsync,
  breakTailReserve,
  emptyBreak,
  joinBreak,
  renderBreakHead,
  renderBreakTail,
  type BreakClip,
  type BreakFiles,
  type BreakUsed,
  type BreakVoices,
} from './break-show';
import { loadBreakBook, type BreakBook } from './breaks';
import {
  DedicationQueue,
  dedicationText,
  joinClips,
  joinIntro,
  type WaitingDedication,
} from './dedications';
import {
  GENRE_JINGLE_RESERVE_SEC,
  JINGLE_GAP_MS,
  JingleLibrary,
  genreJingle,
  namedJingle,
  pickJingle,
  playNewFindJingle,
} from './jingles';
import type { GenreId, GenreIndex } from './genres';
import { artistKey, genreName } from './genres';
import { rotationAfter, GENRE_ROTATION, type RotationCursor } from './rotation';
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
import {
  openerDropReason,
  openerIsBlocked,
  preparedShowLine,
  timelessOpener,
  type PreparedOpener,
} from './opener';
import { pcmLoudness, type DjVoice } from './voice';
import type { DjWriter } from './writer';
import {
  CRATE_SIZE,
  SET_MAX,
  SET_MIN,
  isSameSong,
  plainTitle,
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
/**
 * The show's first line, when it was not prepared ahead. The music waits no
 * longer than this for it: a slow voice leaves the line on the card as text.
 */
const OPENER_WAIT_MS = 8_000;
/** A dedication is read whatever it costs: its clip starts when it is accepted. */
const DEDICATION_WAIT_MS = 25_000;
/** A between-blocks break is built ahead. The player still waits this long for it. */
const BREAK_WAIT_MS = 60_000;
/** Once the player is waiting, a break whose tail is still missing goes out with its head. */
const BREAK_DEADLINE_MS = 45_000;
/** Related-artist and top-track calls one mixed set may spend on Deezer. */
const DISCOVER_DEEZER_CALLS = 8;
/** YouTube searches one mixed set may spend looking for a new find. */
const DISCOVER_YOUTUBE_CALLS = 4;
/** YouTube searches a find pass may have in flight at once. */
const SEARCH_AT_ONCE = 3;
/** Missed find queries kept per server. The oldest drop off once this fills. */
const DEAD_CAP = 500;
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

/** A find search running beside the others. `reserved` fires once that pick is taken. */
interface SearchJob {
  reserved: Promise<void>;
  result: Promise<{ pick: { artist: string; title: string }; hit: Track } | null>;
}

function shuffleItems<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = swap;
  }
  return copy;
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
  jingle?: DjVoice;
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
  /** Edge voice name the prepared opener was made with. */
  voiceName?: string;
  /**
   * First song of the next show, already found and voiced.
   * The station uses it for set 1 when it is still valid, then forgets it.
   */
  prepared?: PreparedOpener | null;
  /** Forget the stored opener once this show uses it or drops it. */
  consumeOpener?: () => void;
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
  /** First set of a rotation block. The break or the opener already played. */
  blockStart?: boolean;
  /** Set when the set belongs to a rotation block. */
  rotationGenre?: GenreId | null;
  /** Still loading later songs. `peek` waits for those instead of planning another set. */
  filling?: Promise<void> | null;
  /** Wakes a `peek` that ran out of loaded songs while `filling` is set. */
  wake?: (() => void) | null;
  /** PCM prepared before the show. Absent means synthesize `line` when it is asked for. */
  preparedClip?: Buffer;
  /** The break before this set. Only the first song of a later rotation block has one. */
  breakClip?: Promise<StationIntro | null>;
  /**
   * Starts the break's own deadline. Called when the player starts waiting for
   * it, not when it is planned: the song before still has minutes to run then.
   */
  breakDue?: () => void;
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
  /** Find queries this show noted, when the server did not hand in a shared list. */
  private readonly ownDead: { artist: string; title: string }[] = [];
  /** Picks a search has taken, so a parallel search does not ask for the same song. */
  private readonly reservedFinds: { artist: string; title: string }[] = [];
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
  /** Steps 1–3 of the break after this block. Started once the block's songs are known. */
  private breakHead: Promise<BreakClip> | null = null;
  /** Promos and station IDs already said this show. */
  private readonly breakUsed: BreakUsed = { ids: new Set(), promos: new Set() };
  /** Jingle files already played this show, so the next pick is a different one. */
  private readonly jingleUsed = {
    ids: new Set<string>(),
    sweepers: new Set<string>(),
    beds: new Set<string>(),
  };
  /** The rotation block that already played its new-find jingle. */
  private newFindJingleGenre: GenreId | null = null;
  private breakBookCache: BreakBook | null | undefined;
  /**
   * A thin genre is being filled to five songs while preparing an opener.
   * The one-song cap stays off until that fill decides the genre is playable.
   */
  private rotationScan = false;
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
    this.prepared = deps.prepared ?? null;
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
    this.rememberRotation();
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
      await this.readAired();
      const unaired = pool.filter((song) => !this.taken(song));
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
      airedKeys: this.airedNow.keys,
      airedUrls: this.airedNow.urls,
      plannedKeys: this.plannedKeys,
      plannedUrls: this.plannedUrls,
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
    this.markPlanned(opener.key, track.url);
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
    const slots = this.slots({ hour: 0, minute: 0, set: 1, newcomers: [] }, vibe, song);
    return (
      preparedShowLine(this.lineBook?.of('showOpen') ?? [], slots) ??
      timelessOpener({
        language: this.deps.language,
        server: this.deps.guild.name,
        vibe,
        song,
      })
    );
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
    if (set.breakClip) {
      const pending = this.intros.get(set);
      if (pending) return pending;
      this.intros.set(set, set.breakClip);
      return set.breakClip;
    }
    const pending = this.intros.get(set);
    if (pending) return pending;
    const next = this.speakSetLine(set);
    this.intros.set(set, next);
    return next;
  }

  /**
   * The set line, with a station ID in front of the opener and a new-find
   * jingle in front of a later set. The file is decoded beside the voice,
   * and a failed decode leaves the line on its own.
   */
  private speakSetLine(set: FmSet): Promise<StationIntro | null> {
    const lead = this.stationLead(set);
    if (set.preparedClip?.length) {
      const pcm = set.preparedClip;
      return lead.then((jingle) => this.withLead(set, { text: set.line, pcm }, jingle));
    }
    return Promise.all([this.deps.voice.speak(set.line), lead])
      .then(([pcm, jingle]) => {
        if (!pcm?.length) {
          this.intros.delete(set);
          return { text: set.line, pcm: null };
        }
        return this.withLead(set, { text: set.line, pcm }, jingle);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM intro failed:', error);
        this.intros.delete(set);
        return { text: set.line, pcm: null };
      });
  }

  /**
   * `new-find` once in a later set of the block. The opener has no jingle: the
   * show should get to its first song as fast as it can, and `id-main` plays in
   * the breaks.
   */
  private stationLead(set: FmSet): Promise<Buffer | null> {
    const lib = this.deps.jingles;
    if (!lib) return Promise.resolve(null);
    return this.loadLead(set, lib).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM jingle failed:', error);
      return null;
    });
  }

  private async loadLead(set: FmSet, lib: JingleLibrary): Promise<Buffer | null> {
    if (set.opener) return null;
    const first = set.tracks[0];
    const how = (first && this.about.get(first)?.how) || 'play';
    if (
      !playNewFindJingle({
        how,
        opener: Boolean(set.opener),
        blockStart: Boolean(set.blockStart),
        played: this.newFindJingleGenre !== null && this.newFindJingleGenre === set.rotationGenre,
        rotation: Boolean(set.rotationGenre),
      })
    ) {
      return null;
    }
    const pcm = await lib.clip(namedJingle(lib.files(), 'new-find'));
    if (!pcm?.length) return null;
    return pcm;
  }

  /** The jingle, half a second of quiet, then the line. The card text stays the line. */
  private withLead(set: FmSet, intro: StationIntro, lead: Buffer | null): StationIntro {
    if (!intro.pcm?.length || !lead?.length) return { text: intro.text, pcm: intro.pcm };
    if (!set.opener && set.rotationGenre) this.newFindJingleGenre = set.rotationGenre;
    return { text: intro.text, pcm: joinClips([lead, intro.pcm], JINGLE_GAP_MS) };
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
    const jingle = spoken?.length ? await this.dedicationClip() : null;
    const text = [dedication.text, set?.text].filter(Boolean).join(' ');
    const pcm = joinIntro(spoken, set?.pcm ?? null, jingle);
    // A missing part is not final: the next intro tries that part again.
    if (!spoken?.length || (setLine && !set?.pcm?.length)) this.combined.delete(track);
    return { text, pcm };
  }

  /** `dedication.mp3` ahead of the spoken message. Null when the file is missing. */
  private dedicationClip(): Promise<Buffer | null> {
    const lib = this.deps.jingles;
    if (!lib) return Promise.resolve(null);
    return lib.clip(namedJingle(lib.files(), 'dedication')).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM jingle failed:', error);
      return null;
    });
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
    await this.readAired();
    const unaired = pool.filter((song) => !this.taken(song));
    const clock = zonedParts(this.deps.timezone);
    const number = this.vibes.length + 1;
    if (number === 1) {
      this.deps.logger.info(
        `Kitchen FM in ${this.deps.guild.name}: ${this.airedNow.keys.size} songs already aired, ` +
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
        line: held ?? this.speak(live.base, live.vibe, track, live.newBlock),
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
      line: holdLine ? '' : this.speak(base, vibe, tracks[0], newBlock),
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

    const tracks: Track[] = [];
    this.claim(tracks, plan.vibe, false);
    const airedNames = this.airedNames();
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
    const theme = picked?.theme ?? { kind: 'mix' as const };
    const vibe = themeName(theme, this.deps.language);
    const tracks: Track[] = [];
    this.claim(tracks, vibe, false);
    await this.loadOrdered(chosen, tracks);

    const index = this.deps.genres;
    if (allowance > 0 && this.deps.catalog && index && tracks.length < SET_MAX) {
      const listenerIds = new Set(listeners.map((member) => member.id));
      await this.discover(pool, null, allowance, listenerIds, index, tracks);
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
    const open = unaired.filter((song) => !this.plannedThisShow(song));
    const reserve = open.length < SET_MIN ? Math.min(open.length, SET_MAX) : 0;
    const vibe = this.deps.language === 'cs' ? 'podobní interpreti' : 'similar artists';
    const tracks: Track[] = [];
    this.claim(tracks, vibe, false);
    await this.discover(pool, null, SET_MAX - reserve, listenerIds, index, tracks);
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
    const waiting = list.filter((song) => !this.plannedThisShow(song));
    const source = waiting.length > 0 ? waiting : list.length > 0 ? list : pool;
    const ordered = [...source].sort(
      (a, b) => this.lastAiredAt(a) - this.lastAiredAt(b) || a.key.localeCompare(b.key),
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
      await this.discover(pool, genre, finds, listenerIds, index, tracks);
    }
    // Top up only with unaired songs of the same genre: a short set beats one under the wrong name.
    const same = unaired.filter(
      (song) => index.genreOf(song.key) === genre && !this.plannedThisShow(song),
    );
    await this.fill(tracks, same);
  }

  /** Station songs in one rotation block, clamped to 5–30. */
  private blockSongCount(): number {
    const count = this.deps.blockSongs;
    if (typeof count !== 'number' || !Number.isFinite(count)) return 15;
    return Math.min(30, Math.max(5, Math.round(count)));
  }

  /** Break length in seconds, clamped to 0–300. 0 means the usual block line. */
  private breakLength(): number {
    const seconds = this.deps.breakSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 180;
    return Math.min(300, Math.max(0, Math.round(seconds)));
  }

  /** Preparing an opener loads one song, unless a thin genre is being proved. */
  private oneSong(): boolean {
    return this.preparingOpener && !this.rotationScan;
  }

  private breakLines(): BreakBook | null {
    if (this.breakBookCache === undefined) this.breakBookCache = loadBreakBook();
    return this.breakBookCache;
  }

  /** The DJ reads the recap. Station IDs use the jingle voice, or nothing. */
  private breakVoices(): BreakVoices {
    const dj = this.deps.voice;
    const jingle = this.deps.jingle;
    return {
      dj: (text, budget) => dj.speak(text, budget),
      jingle: jingle ? (text, budget) => jingle.speak(text, budget) : async () => null,
    };
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
    const open = unaired.filter((song) => !this.plannedThisShow(song));

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
      this.startBreakHead();
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
      const cap = Math.min(SET_MAX, this.blockSongCount());
      const hold =
        base.set > 1 && this.breakHead !== null && this.breakLength() > 0 && !this.preparingOpener;
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
        if (base.set > 1) this.armBreak(set, genre, base);
        this.noteRotation(genre, set.tracks, cap);
        return set;
      }
      this.deps.logger.info(
        `Kitchen FM in ${this.deps.guild.name}: no playable songs for ${genreName(genre, this.deps.language)}.`,
      );
      genre = rotationAfter(genre);
    }
    this.breakHead = null;
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
    const required = newBlock ? Math.min(SET_MAX, this.blockSongCount()) : 1;
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
      await this.discover(pool, genre, take - tracks.length, listenerIds, index, tracks);
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
        await this.discover(pool, genre, gap(), listenerIds, index, tracks);
      }
      if (gap() > 0 && tracks.length < required && this.deps.genreTracks) {
        await this.addPlaylist(genre, pool, tracks, gap());
      }
      // Keep filling the set once it is viable, up to `take`.
      if (tracks.length >= required && gap() > 0 && this.deps.catalog && index) {
        await this.discover(pool, genre, gap(), listenerIds, index, tracks);
      }
      if (tracks.length >= required && gap() > 0 && this.deps.genreTracks) {
        await this.addPlaylist(genre, pool, tracks, gap());
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
        this.plannedKeys.delete(key);
        const at = this.recent.lastIndexOf(key);
        if (at >= 0) this.recent.splice(at, 1);
        this.songKeys.delete(track);
      }
      if (track.url) this.plannedUrls.delete(track.url);
      this.about.delete(track);
      this.setOf.delete(track);
    }
    tracks.length = 0;
  }

  /** Count this set toward the block. A short set, or a full block, closes it. */
  private noteRotation(genre: GenreId, tracks: readonly Track[], wanted: number): void {
    const limit = this.blockSongCount();
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
      this.startBreakHead();
    }
  }

  private logBlock(genre: GenreId, limit: number): void {
    const name = (id: GenreId) => genreName(id, this.deps.language);
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: ${name(genre)} for ${limit} songs (next: ${name(rotationAfter(genre))}).`,
    );
  }

  /** Steps 1–3, as soon as the block's artists are known. No-op when the break is off. */
  private startBreakHead(): void {
    if (this.preparingOpener || this.breakLength() <= 0 || this.breakHead || !this.rotation) return;
    const book = this.breakLines();
    if (!book) return;
    const slots = {
      server: this.deps.guild.name,
      lastGenre: genreName(this.rotation.genre, 'en'),
      artists: joinNames(this.rotation.artists.slice(0, 3), 'en'),
    };
    const files = this.breakFiles(null);
    this.breakHead = this.renderHead(book, slots, files).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM break failed:', error);
      return emptyBreak();
    });
  }

  /** The head, leaving room for the tail's real jingle files when the folder has them. */
  private async renderHead(
    book: BreakBook,
    slots: { server: string; lastGenre: string; artists: string },
    files: BreakFiles | null,
  ): Promise<BreakClip> {
    let tail = BREAK_TAIL_SEC;
    if (files) {
      const back = await files.back().catch(() => null);
      tail = breakTailReserve(back?.length ? pcmSeconds(back) : 0, this.genreReserveSec());
    }
    return renderBreakHead(
      book,
      slots,
      this.breakVoices(),
      this.breakUsed,
      this.breakLength(),
      Math.random,
      tail,
      files,
    );
  }

  /** A station-ID or sweeper file, marked used so the next break can pick another. */
  private pickClip(kind: 'id' | 'sweeper'): Promise<Buffer | null> {
    const lib = this.deps.jingles;
    if (!lib) return Promise.resolve(null);
    const used = kind === 'id' ? this.jingleUsed.ids : this.jingleUsed.sweepers;
    return lib.clip(pickJingle(lib.files(), kind, used, Math.random));
  }

  /** Files for one break. `genre` null means the tail does not know the next block yet. */
  private breakFiles(genre: GenreId | null): BreakFiles | null {
    const lib = this.deps.jingles;
    if (!lib) return null;
    return {
      id: () => this.pickClip('id'),
      sweeper: () => this.pickClip('sweeper'),
      back: () => lib.clip(namedJingle(lib.files(), 'back-to-music')),
      genre: () => (genre ? lib.clip(genreJingle(lib.files(), genre)) : Promise.resolve(null)),
    };
  }

  /** How long a genre jingle might be. Zero when the folder has none. */
  private genreReserveSec(): number {
    const lib = this.deps.jingles;
    if (!lib?.files().some((file) => file.kind === 'genre')) return 0;
    return GENRE_JINGLE_RESERVE_SEC;
  }

  /** The next block's first song carries the break. The card names only the genre. */
  private armBreak(set: FmSet, genre: GenreId, base: SetBase): void {
    if (!this.breakHead || this.breakLength() <= 0 || this.preparingOpener || !set.tracks[0]) {
      return;
    }
    const vibe = genreName(genre, this.deps.language);
    set.line = `📻 Kitchen FM break · next up: ${genreName(genre, 'en')}`;
    set.breakClip = this.composeBreak(genre, set, base, vibe);
  }

  /**
   * Head, then the tail. Ready within a minute: a slow tail still plays the
   * head, and a break with no voice at all falls back to the block line.
   */
  private composeBreak(
    genre: GenreId,
    set: FmSet,
    base: SetBase,
    vibe: string,
  ): Promise<StationIntro | null> {
    const card = `📻 Kitchen FM break · next up: ${genreName(genre, 'en')}`;
    const head = this.breakHead ?? Promise.resolve(emptyBreak());
    this.breakHead = null;
    const book = this.breakLines();
    const tail = book
      ? renderBreakTail(
          book,
          {
            genre: genreName(genre, 'en'),
            songs: this.comingSongs(set.tracks),
            count: String(this.blockSongCount()),
          },
          this.breakVoices(),
          Math.random,
          this.breakFiles(genre),
        ).catch((error: unknown) => {
          this.deps.logger.warn('Kitchen FM break failed:', error);
          return emptyBreak();
        })
      : Promise.resolve(emptyBreak());

    let headReady: BreakClip | null = null;
    void head.then((clip) => {
      headReady = clip;
    });

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deliver = (clip: BreakClip | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.ended) {
          resolve(null);
          return;
        }
        void this.finishBreak(clip, card, base, vibe, set).then(resolve, () =>
          resolve({ text: card, pcm: null }),
        );
      };
      // A late tail still lets the head play. The fallback block line needs a
      // few seconds of its own, so this fires before the player stops waiting.
      set.breakDue = () => {
        if (settled || timer) return;
        timer = setTimeout(() => {
          deliver(headReady?.voiced ? headReady : null);
        }, BREAK_DEADLINE_MS);
        timer.unref?.();
      };
      void Promise.all([head, tail])
        .then(([heard, next]) => deliver(joinBreak(heard, next)))
        .catch((error: unknown) => {
          this.deps.logger.warn('Kitchen FM break failed:', error);
          deliver(headReady?.voiced ? headReady : null);
        });
    });
  }

  /** The break clip, or the usual new-block line when no voice made it in. */
  private async finishBreak(
    clip: BreakClip | null,
    card: string,
    base: SetBase,
    vibe: string,
    set: FmSet,
  ): Promise<StationIntro> {
    const laid = await this.layBed(clip);
    if (laid?.voiced && laid.pcm?.length) return { text: card, pcm: laid.pcm };
    const first = set.tracks[0];
    const line = first ? this.speak(base, vibe, first, true) : card;
    const pcm = await this.deps.voice.speak(line, BREAK_SPEAK_MS).catch(() => null);
    return { text: line, pcm };
  }

  /** One music bed under the whole break. A missing file leaves the voices as they are. */
  private async layBed(clip: BreakClip | null): Promise<BreakClip | null> {
    if (!clip?.pcm?.length) return clip;
    const lib = this.deps.jingles;
    if (!lib) return clip;
    try {
      const file = pickJingle(lib.files(), 'bed', this.jingleUsed.beds, Math.random);
      const bed = await lib.bed(file, Math.max(0.1, clip.seconds));
      return await applyBedAsync(clip, bed);
    } catch (error: unknown) {
      this.deps.logger.warn('Kitchen FM bed failed:', error);
      return clip;
    }
  }

  /** The next block's first songs, as "Title by Artist", up to three. */
  private comingSongs(tracks: readonly Track[]): string {
    const names = tracks.slice(0, 3).map((track) => {
      const about = this.about.get(track);
      return songPhrase(about?.artist ?? '', about?.title || track.title, 'en');
    });
    return joinNames(names, 'en');
  }

  /** The genre this show got to, so the next one starts after it. */
  private rememberRotation(): void {
    const cursor = this.deps.rotationCursor;
    if (!cursor || !this.rotation) return;
    cursor.genre = this.rotation.genre;
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

  /**
   * Related artists the kitchen has not played, then one of their top tracks
   * from YouTube. When that ring runs out, the next ring, then the kitchen
   * artists' own unplayed tops. Up to three searches run at once, and results
   * are kept in candidate order. A cache hit is not a Deezer call. A finds-only
   * set (more than 3) may look further than a mixed one.
   */
  private async discover(
    pool: FmSong[],
    genre: GenreId | null,
    allowance: number,
    listenerIds: ReadonlySet<string>,
    index: GenreIndex,
    into?: Track[],
  ): Promise<Track[]> {
    const tracks = into ?? [];
    const catalog = this.deps.catalog;
    if (!catalog || allowance <= 0 || this.ended) return tracks;
    const started = tracks.length;
    const added = (): number => tracks.length - started;
    const kitchenArtists = new Set(pool.map((song) => artistKey(song.artist)).filter(Boolean));
    const blocked = await this.blockedSongs(pool);
    // A genre block seeds from that genre. A themed set seeds from the whole kitchen.
    const seeded = genre === null ? pool : pool.filter((song) => index.genreOf(song.key) === genre);
    const seeds = seedArtistIds(
      seeded.map((song) => ({ from: song.from, deezerArtistId: index.artistId(song.key) })),
      listenerIds,
    );
    const budget = { deezer: 0, youtube: 0 };
    const deezerCap = allowance > 3 ? allowance * 4 + 4 : DISCOVER_DEEZER_CALLS;
    const youtubeCap = allowance > 3 ? allowance * 2 : DISCOVER_YOUTUBE_CALLS;
    // Preparation stops at the first song. The caps stay what a full opening set may spend.
    const limit = this.oneSong() ? Math.min(allowance, 1) : allowance;
    const room = (): boolean =>
      !this.ended &&
      added() < limit &&
      tracks.length < SET_MAX &&
      budget.deezer < deezerCap &&
      budget.youtube < youtubeCap;
    const seen = new Set<number>(seeds);
    let frontier = [...seeds];
    let frontierPos = 0;
    const nextFrontier: number[] = [];
    let related: { id: number; name: string }[] = [];
    let relatedPos = 0;
    let loaded = false;
    let phase: 'rings' | 'seeds' = 'rings';
    let seedPos = 0;

    const nextId = async (): Promise<number | null> => {
      while (phase === 'rings' && room()) {
        if (!loaded) {
          if (frontierPos >= frontier.length) {
            if (nextFrontier.length === 0) {
              phase = 'seeds';
              break;
            }
            frontier = nextFrontier.splice(0);
            frontierPos = 0;
            continue;
          }
          related = await this.cachedRelated(frontier[frontierPos]!, budget, deezerCap);
          relatedPos = 0;
          loaded = true;
        }
        while (relatedPos < related.length && room()) {
          const artist = related[relatedPos++]!;
          if (kitchenArtists.has(artistKey(artist.name)) || seen.has(artist.id)) continue;
          seen.add(artist.id);
          nextFrontier.push(artist.id);
          return artist.id;
        }
        frontierPos += 1;
        loaded = false;
      }
      // Still short: more from the kitchen's own artists, songs it has not played.
      while (seedPos < seeds.length && room()) return seeds[seedPos++]!;
      return null;
    };

    await this.runWindow(
      async () => {
        if (!room()) return null;
        const id = await nextId();
        if (id === null || !room()) return null;
        return this.beginTake(id, blocked, budget, deezerCap, youtubeCap);
      },
      tracks,
      limit,
      started,
    );
    return tracks;
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
   * `ready` fires once this artist has taken its pick, so the next search may start.
   */
  private async takeFrom(
    artistId: number,
    blocked: BlockedSongs,
    budget: { deezer: number; youtube: number },
    deezerCap: number,
    youtubeCap: number,
    ready: () => void,
  ): Promise<{ pick: { artist: string; title: string }; hit: Track } | null> {
    try {
      if (this.ended || this.exhaustedArtists.has(artistId) || budget.youtube >= youtubeCap) {
        return null;
      }
      const tops = await this.cachedTops(artistId, budget, deezerCap);
      if (!tops || this.ended) return null;
      const view = this.holding(blocked);
      while (!this.ended && budget.youtube < youtubeCap) {
        const pick = pickDiscoverTrack(tops, view, Math.random);
        if (!pick) {
          this.exhaustedArtists.add(artistId);
          return null;
        }
        this.reserve(pick);
        budget.youtube += 1;
        ready();
        const found = await this.lookup(pick, blocked);
        if (found === 'threw') return null;
        if (found) return found;
      }
      return null;
    } finally {
      ready();
    }
  }

  /** Playlist tracks for `genre`, shuffled, searched like a find. Empty on failure. */
  private async addPlaylist(
    genre: GenreId,
    pool: FmSong[],
    into: Track[],
    allowance: number,
  ): Promise<void> {
    const load = this.deps.genreTracks;
    if (!load || allowance <= 0 || this.ended) return;
    let list: DeezerTop[];
    try {
      list = await load(genre);
    } catch (error: unknown) {
      this.deps.logger.warn(`Kitchen FM could not load playlist tracks for ${genre}:`, error);
      return;
    }
    const blocked = await this.blockedSongs(pool);
    const candidates = shuffleItems(list);
    let index = 0;
    const budget = { youtube: 0 };
    const youtubeCap = allowance > 3 ? allowance * 2 : DISCOVER_YOUTUBE_CALLS;
    const limit = this.oneSong() ? Math.min(allowance, 1) : allowance;
    const started = into.length;
    await this.runWindow(
      () => {
        if (this.ended || budget.youtube >= youtubeCap) return null;
        const view = this.holding(blocked);
        while (index < candidates.length) {
          const pick = candidates[index++]!;
          if (!songFits(pick.durationSec) || view.matches(pick)) continue;
          budget.youtube += 1;
          return this.beginLookup(pick, blocked);
        }
        return null;
      },
      into,
      limit,
      started,
    );
  }

  /**
   * Keep up to `SEARCH_AT_ONCE` lookups in flight. A hit is appended in the
   * order its search was started, so a later result cannot jump the queue.
   */
  private async runWindow(
    start: () => Promise<SearchJob | null> | SearchJob | null,
    into: Track[],
    allowance: number,
    started: number,
  ): Promise<void> {
    const jobs: SearchJob[] = [];
    let commit = 0;
    const added = (): number => into.length - started;
    let sourceDone = false;

    const placeNext = async (): Promise<void> => {
      const job = jobs[commit];
      if (!job) return;
      commit += 1;
      const found = await job.result;
      if (!found || this.ended) return;
      if (added() >= allowance || into.length >= SET_MAX) return;
      this.acceptFind(found.pick, found.hit);
      this.place(into, found.hit);
    };

    while (!sourceDone || commit < jobs.length) {
      while (!sourceDone && jobs.length - commit < SEARCH_AT_ONCE) {
        if (this.ended || added() >= allowance || into.length >= SET_MAX) {
          sourceDone = true;
          break;
        }
        const job = await start();
        if (!job) {
          sourceDone = true;
          break;
        }
        jobs.push(job);
        await job.reserved;
      }
      if (commit >= jobs.length) break;
      await placeNext();
    }
  }

  private beginTake(
    artistId: number,
    blocked: BlockedSongs,
    budget: { deezer: number; youtube: number },
    deezerCap: number,
    youtubeCap: number,
  ): SearchJob {
    const { reserved, ready } = this.readyGate();
    return {
      reserved,
      result: this.takeFrom(artistId, blocked, budget, deezerCap, youtubeCap, ready),
    };
  }

  private beginLookup(pick: { artist: string; title: string }, blocked: BlockedSongs): SearchJob {
    this.reserve(pick);
    const { reserved, ready } = this.readyGate();
    return { reserved, result: this.finishLookup(pick, blocked, ready) };
  }

  /** Resolves on the first `ready` call. A second call does nothing. */
  private readyGate(): { reserved: Promise<void>; ready: () => void } {
    let signal = (): void => {};
    const reserved = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let opened = false;
    return {
      reserved,
      ready: () => {
        if (opened) return;
        opened = true;
        signal();
      },
    };
  }

  /** One playlist candidate. A miss is noted here. A hit is accepted when it is placed. */
  private async finishLookup(
    pick: { artist: string; title: string },
    blocked: BlockedSongs,
    ready: () => void,
  ): Promise<{ pick: { artist: string; title: string }; hit: Track } | null> {
    try {
      ready();
      const found = await this.lookup(pick, blocked);
      return found === 'threw' ? null : found;
    } finally {
      ready();
    }
  }

  /**
   * Search YouTube for `pick`. A miss or an already-aired upload is a dead find.
   * A thrown search is not, and the pick is free for a later set.
   */
  private async lookup(
    pick: { artist: string; title: string },
    blocked: BlockedSongs,
  ): Promise<{ pick: { artist: string; title: string }; hit: Track } | null | 'threw'> {
    // "(2012 Remaster)" is Deezer's label, not part of any upload's title.
    const query = `${pick.artist} - ${plainTitle(pick.title)}`;
    let threw = false;
    const hit = await this.deps.source.youtube
      .searchOne(query, NEW_FIND)
      .catch((error: unknown) => {
        threw = true;
        this.deps.logger.warn(`Kitchen FM: YouTube search failed for "${query}":`, error);
        return null;
      });
    this.unreserve(pick);
    if (threw) return 'threw';
    if (!hit || !songFits(hit.durationSec) || !isSameSong(pick, hit)) {
      this.rejectFind(pick, blocked, false);
      return null;
    }
    if (this.plannedUrls.has(hit.url) || this.airedNow.urls.has(hit.url)) {
      this.rejectFind(pick, blocked, true);
      return null;
    }
    blocked.add(pick);
    return { pick, hit };
  }

  private acceptFind(pick: { artist: string; title: string }, hit: Track): void {
    this.deps.logger.info(`Kitchen FM: new find "${pick.artist} - ${pick.title}".`);
    hit.stationPick = true;
    this.about.set(hit, { artist: pick.artist, title: pick.title, by: null, how: 'new' });
    this.rememberFind(hit);
  }

  private rejectFind(
    pick: { artist: string; title: string },
    blocked: BlockedSongs,
    aired: boolean,
  ): void {
    const query = `${pick.artist} - ${pick.title}`;
    this.noteDead(pick.artist, pick.title);
    blocked.add(pick);
    this.deps.logger.info(
      aired
        ? `Kitchen FM: "${query}" already aired.`
        : `Kitchen FM: no YouTube match for the new find "${query}".`,
    );
  }

  /** Blocked songs plus picks a search has already taken. */
  private holding(blocked: BlockedSongs): BlockedSongs {
    const reserved = this.reservedFinds;
    return {
      matches: (song) =>
        blocked.matches(song) ||
        reserved.some((item) => item.artist === song.artist && item.title === song.title),
      add: (song) => blocked.add(song),
    };
  }

  private reserve(pick: { artist: string; title: string }): void {
    this.reservedFinds.push({ artist: pick.artist, title: pick.title });
  }

  private unreserve(pick: { artist: string; title: string }): void {
    const at = this.reservedFinds.findIndex(
      (item) => item.artist === pick.artist && item.title === pick.title,
    );
    if (at >= 0) this.reservedFinds.splice(at, 1);
  }

  /** Kitchen songs, this show, dead finds, thumbs-down, and what already aired. */
  private async blockedSongs(pool: readonly FmSong[]): Promise<BlockedSongs> {
    const extra = (await this.deps.findBlocks?.()) ?? [];
    return prepareBlocked([
      ...pool.map((song) => ({ artist: song.artist, title: song.title })),
      ...this.played.map(splitPlayed),
      ...this.deadList(),
      ...extra,
      ...this.airedNow.rows.map((row) => ({ artist: row.artist, title: row.title })),
    ]);
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

    const title = plainTitle(song.title);
    const query = song.artist ? `${song.artist} - ${title}` : title;
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

  /** Find queries YouTube could not match, shared across shows when the server passed one in. */
  private deadList(): { artist: string; title: string }[] {
    return this.deps.deadFinds ?? this.ownDead;
  }

  /** Remember a find query that YouTube could not match. A thrown search does not come here. */
  private noteDead(artist: string, title: string): void {
    const list = this.deadList();
    if (list.some((song) => song.artist === artist && song.title === title)) return;
    list.push({ artist, title });
    if (list.length > DEAD_CAP) list.splice(0, list.length - DEAD_CAP);
  }

  /** Aired songs and dead finds, so Claude's crate-less names can be refused. */
  private airedNames(): BlockedSongs {
    return prepareBlocked([
      ...this.airedNow.rows.map((row) => ({ artist: row.artist, title: row.title })),
      ...this.deadList(),
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
