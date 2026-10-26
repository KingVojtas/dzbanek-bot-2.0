import type { Guild, GuildMember } from 'discord.js';
import type { Logger } from '../core/logger';
import type { PlayerStation, StationIntro, Track } from '../core/types';
import { zonedParts } from '../kitchen/time';
import type { CompositeTrackSource } from '../music/sources';
import { getStation } from '../radio/station';
import type { FmCatalog } from './catalog';
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
  REPEAT_GAP,
  SET_MAX,
  SET_MIN,
  isSameSong,
  pickSong,
  relativeDay,
  sampleCrate,
  songFits,
  templateOpener,
  themeName,
  themedSet,
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
/** Related-artist and top-track calls one set may spend on Deezer. */
const DISCOVER_DEEZER_CALLS = 8;
/** YouTube searches one set may spend looking for a new find. */
const DISCOVER_YOUTUBE_CALLS = 4;
/** Fewer kitchen songs than this: one set of them, then sets of new finds. */
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
  private readonly intros = new WeakMap<FmSet, Promise<StationIntro | null>>();
  private lastTheme: Theme['kind'] | undefined;
  /** Who was listening when the current set started. */
  private heard = new Set<string>();
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

  starting(track: Track): void {
    const set = this.setOf.get(track);
    if (!set) return;
    if (set === this.pending && set.tracks[0] === track) {
      this.pending = null;
      this.current = set;
      this.vibes.push(set.vibe);
      this.heard = new Set(this.deps.listeners().map((member) => member.id));
    }
    // Requests and replays leave the set where it was.
    if (set !== this.current || set.tracks[set.next] !== track) return;
    set.next += 1;
    this.peeking = null;
  }

  intro(track: Track): Promise<StationIntro | null> {
    if (this.ended) return Promise.resolve(null);
    const set = this.setOf.get(track);
    // The DJ talks once a set, before its first song.
    if (!set || set.tracks[0] !== track) return Promise.resolve(null);
    let pending = this.intros.get(set);
    if (!pending) {
      pending = this.deps.voice
        .speak(set.line)
        .then((pcm) => ({ text: set.line, pcm }))
        .catch((error: unknown) => {
          this.deps.logger.warn('Kitchen FM intro failed:', error);
          return { text: set.line, pcm: null };
        });
      this.intros.set(set, pending);
    }
    return pending;
  }

  /** The opener may wait longer. Every later intro uses the player's usual wait. */
  introWaitMs(track: Track): number | undefined {
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
    this.onEnd();
  }

  private async peek(): Promise<Track | null> {
    const queued = this.queued();
    if (queued) return queued;
    this.pending = await this.plan();
    return this.pending?.tracks[0] ?? null;
  }

  /** The next set: a genre block when enough songs are classified, else Claude, else a themed set. */
  private async plan(): Promise<FmSet | null> {
    const listeners = this.deps.listeners();
    if (listeners.length === 0) {
      this.deps.logger.info(`Kitchen FM in ${this.deps.guild.name}: nobody is listening.`);
      return null;
    }
    const pool = (await this.deps.pool()).filter((song) => songFits(song.durationSec));
    const clock = zonedParts(this.deps.timezone);
    const number = this.vibes.length + 1;
    const base: SetBase = {
      hour: clock.hour,
      minute: clock.minute,
      set: number,
      newcomers:
        number > 1
          ? listeners
              .filter((member) => !this.heard.has(member.id))
              .map((member) => member.displayName)
          : [],
    };
    const time = `${clock.weekday} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;

    // The first set is the kitchen's own songs, so the show can start at once.
    // A small kitchen's later sets are new finds from similar artists.
    // A set that fails (a search that threw, a catalog hiccup) falls back; the show goes on.
    const findSet =
      number > 1 && pool.length < SMALL_KITCHEN
        ? await this.planFinds(pool, base, listeners).catch((error: unknown) => {
            this.deps.logger.warn('Kitchen FM could not plan a set of new finds:', error);
            return null;
          })
        : null;
    const blockSet =
      findSet ??
      (await this.planBlocks(pool, base, listeners).catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM could not plan a genre set:', error);
        return null;
      }));
    const set =
      blockSet ??
      (await this.planWithClaude(pool, base, time, listeners)) ??
      (await this.planThemed(pool, base, listeners));
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
      if (!intro?.pcm?.length) {
        this.deps.logger.info('Kitchen FM voice: text only');
        return;
      }
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
    pool: FmSong[],
    base: SetBase,
    time: string,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    if (!this.deps.writer.ready) return null;
    const crateSongs = sampleCrate(pool, this.recent, CRATE_SIZE);
    const names = await this.namesOf(crateSongs);
    const plan = await this.deps.writer.planSet({
      language: this.deps.language,
      server: this.deps.guild.name,
      time,
      ...base,
      earlierVibes: this.vibes.slice(-VIBES_SHOWN),
      playedThisShow: this.played.slice(-PLAYED_SHOWN),
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
    });
    if (!plan) return null;

    const loaded = await Promise.all(
      plan.songs.map((song) => {
        if (base.set === 1 && song.crate === null) return null;
        return this.loadPlanned(song, crateSongs, pool).catch((error: unknown) => {
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
    await this.fill(tracks, pool);
    if (tracks.length === 0) return null;
    const line =
      loaded[0] && plan.line ? plan.line : this.speak(base, plan.vibe, tracks[0]!, false);
    return { vibe: plan.vibe, line, tracks, next: 0, plannedAt: this.now() };
  }

  private async planThemed(
    pool: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const listenerMap = new Map(listeners.map((member) => [member.id, member.displayName]));
    const gap = new Set(this.recent.slice(-REPEAT_GAP));
    const fresh = pool.filter((song) => !gap.has(song.key));
    const picked =
      fresh.length > 0
        ? themedSet(fresh, [], { listeners: listenerMap, last: this.lastTheme })
        : null;
    // Set 1 is the kitchen's own songs. Later, a small kitchen fills the gap with finds.
    const allowance =
      base.set === 1
        ? 0
        : pool.length < SMALL_KITCHEN
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
    if (tracks.length === 0) {
      const again = themedSet(pool, this.recent, { listeners: listenerMap, last: this.lastTheme });
      if (again) {
        const extra = await Promise.all(
          again.songs.slice(0, SET_MAX).map((song) => this.loadSong(song)),
        );
        for (const track of extra) {
          if (!track || tracks.length >= SET_MAX) continue;
          if (!tracks.some((other) => other.url === track.url)) tracks.push(track);
        }
      }
    }
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
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const index = this.deps.genres;
    if (!index?.ready(pool)) return null;

    const now = this.now();
    const listenerIds = new Set(listeners.map((member) => member.id));
    const genreOf = (song: FmSong) => index.genreOf(song.key);
    const profile = blockProfile(
      tasteProfile(pool, genreOf, { now, listenerIds }),
      pool,
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

    let picked = genreSongs(pool, this.recent, genre, genreOf);
    let finds = this.findBudget(picked.length);
    const runOut = picked.length < SET_MIN;
    if (this.block && !fresh && runOut) {
      const next = nextGenre(profile, this.blockHistory, Math.random);
      if (next && next !== genre) {
        genre = next;
        fresh = true;
        picked = genreSongs(pool, this.recent, genre, genreOf);
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
   * A whole set of new finds from artists related to the kitchen's, for a
   * kitchen too small to fill sets of its own. Null when nothing was found,
   * so the kitchen's songs play instead of silence.
   */
  private async planFinds(
    pool: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const index = this.deps.genres;
    if (!this.deps.catalog || !index || this.deps.discover <= 0) return null;
    const listenerIds = new Set(listeners.map((member) => member.id));
    const tracks = await this.discover(pool, null, SET_MAX, listenerIds, index);
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
    // Top up only with unplayed songs of the same genre: a short set beats one under the wrong name.
    const played = new Set(this.recent);
    const same = pool.filter((song) => index.genreOf(song.key) === genre && !played.has(song.key));
    await this.fill(tracks, same);
    return tracks;
  }

  /**
   * Related artists the kitchen has not played, then one top track from YouTube.
   * One set may ask Deezer 8 times and YouTube 4 times, then it plays what it already has.
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
    const blocked = [
      ...pool.map((song) => ({ artist: song.artist, title: song.title })),
      ...this.played.map(splitPlayed),
    ];
    // A genre block seeds from that genre. A themed set seeds from the whole kitchen.
    const seeded = genre === null ? pool : pool.filter((song) => index.genreOf(song.key) === genre);
    const seeds = seedArtistIds(
      seeded.map((song) => ({ from: song.from, deezerArtistId: index.artistId(song.key) })),
      listenerIds,
    );
    const found: Track[] = [];
    const usedArtists = new Set<number>();
    let deezerCalls = 0;
    let youtubeCalls = 0;
    // A set of finds only (more than 3) may look further. A few seeds may each give more than one.
    const deezerCap = allowance > 3 ? allowance * 2 + 4 : DISCOVER_DEEZER_CALLS;
    const youtubeCap = allowance > 3 ? allowance + 2 : DISCOVER_YOUTUBE_CALLS;
    const perSeed = Math.max(1, Math.ceil(allowance / Math.max(1, seeds.length)));
    const room = (): boolean =>
      found.length < allowance && deezerCalls < deezerCap && youtubeCalls < youtubeCap;
    for (const seedId of seeds) {
      if (!room()) break;
      deezerCalls += 1;
      const related = await catalog.relatedArtists(seedId);
      let fromSeed = 0;
      for (const artist of related) {
        if (!room()) break;
        if (usedArtists.has(artist.id) || kitchenArtists.has(artistKey(artist.name))) continue;
        usedArtists.add(artist.id);
        deezerCalls += 1;
        const tops = await catalog.topTracks(artist.id);
        const pick = pickDiscoverTrack(tops, blocked, Math.random);
        if (!pick) continue;
        const query = `${pick.artist} - ${pick.title}`;
        youtubeCalls += 1;
        // A search that throws (a bot check, a timeout) is no match, not the end of the set.
        const hit = await this.deps.source.youtube
          .searchOne(query, NEW_FIND)
          .catch((error: unknown) => {
            this.deps.logger.warn(`Kitchen FM: YouTube search failed for "${query}":`, error);
            return null;
          });
        if (!hit || !songFits(hit.durationSec) || !isSameSong(pick, hit)) {
          this.deps.logger.info(`Kitchen FM: no YouTube match for the new find "${query}".`);
          continue;
        }
        this.deps.logger.info(`Kitchen FM: new find "${pick.artist} - ${pick.title}".`);
        hit.stationPick = true;
        this.about.set(hit, { artist: pick.artist, title: pick.title, by: null, how: 'new' });
        blocked.push({ artist: pick.artist, title: pick.title });
        found.push(hit);
        fromSeed += 1;
        if (fromSeed >= perSeed) break;
      }
    }
    return found;
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
  ): Promise<Track | null> {
    if (song.crate !== null) {
      const kitchen = crate[song.crate - 1];
      return kitchen ? this.loadSong(kitchen) : null;
    }
    const known = pool.find((kitchen) => isSameSong(song, { title: kitchen.label }));
    if (known) return this.loadSong(known);
    if (this.played.some((label) => isSameSong(song, { title: label }))) return null;

    const query = song.artist ? `${song.artist} - ${song.title}` : song.title;
    const hit = await this.deps.source.youtube.searchOne(query, NEW_FIND);
    if (!hit || !songFits(hit.durationSec) || !isSameSong(song, hit)) {
      this.deps.logger.info(`Kitchen FM: no YouTube match for the new find "${query}".`);
      return null;
    }
    hit.stationPick = true;
    this.about.set(hit, { artist: song.artist, title: song.title, by: null, how: 'new' });
    return hit;
  }

  /** Top a short set up toward five songs. Stops rather than repeat a song from the last few. */
  private async fill(tracks: Track[], pool: FmSong[]): Promise<void> {
    for (let tries = 0; tracks.length < SET_MAX && tries < FILL_TRIES; tries += 1) {
      const blocked = new Set(this.recent.slice(-REPEAT_GAP));
      const open = pool.filter((song) => !blocked.has(song.key));
      const song = open.length > 0 ? pickSong(open, this.recent) : null;
      if (!song || blocked.has(song.key)) return;
      const track = await this.loadSong(song);
      if (track && !tracks.some((other) => other.url === track.url)) tracks.push(track);
    }
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
