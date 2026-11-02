import type { Logger } from '../core/logger';
import type { Track } from '../core/types';
import type { DeezerTop, FmCatalog } from './catalog';
import { artistKey, type GenreId, type GenreIndex } from './genres';
import {
  SET_MAX,
  isSameSong,
  plainTitle,
  prepareBlocked,
  songFits,
  type BlockedSongs,
  type FmSong,
  type OpenerSong,
} from './script';
import { splitPlayed } from './station-aired';
import { pickDiscoverTrack, seedArtistIds } from './taste';

/** Related-artist and top-track calls one mixed set may spend on Deezer. */
const DISCOVER_DEEZER_CALLS = 8;
/** YouTube searches one mixed set may spend looking for a new find. */
const DISCOVER_YOUTUBE_CALLS = 4;
/** YouTube searches a find pass may have in flight at once. */
const SEARCH_AT_ONCE = 3;
/** Shown under "Brought in by" for a song nobody in the kitchen brought. */
export const NEW_FIND = '🎙️ Kitchen FM · new find';

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

/** What a new-find search reads off the station. The show still builds the set around the hits. */
export interface StationDiscoverDeps {
  catalog?: FmCatalog;
  youtube: {
    searchOne(query: string, requestedBy: string): Promise<Track | null>;
  };
  logger: Logger;
  /** Playlist tracks for a genre. Cached by the process, so a warm show spends no Deezer calls. */
  genreTracks?: (genre: GenreId) => Promise<DeezerTop[]>;
  /** New finds a 👎 retired. Read again for every set. */
  findBlocks?: () => Promise<readonly { artist: string; title: string }[]>;
  ended: () => boolean;
  /** Preparing an opener loads one song, unless a thin genre is being proved. */
  oneSong: () => boolean;
  /** "Artist – Title" of every song this show put on. */
  played: () => readonly string[];
  deadList: () => { artist: string; title: string }[];
  airedRows: () => readonly { artist: string; title: string }[];
  /** Planned this show, or already in the aired log. */
  urlTaken: (url: string) => boolean;
  noteDead: (artist: string, title: string) => void;
  place: (tracks: Track[], track: Track) => void;
  rememberFind: (hit: Track) => void;
  aboutSet: (hit: Track, about: OpenerSong) => void;
}

/**
 * New finds: related artists, their top tracks, and a genre playlist.
 * Searches stay in the order they started, and a Deezer answer is reused for
 * the rest of the show.
 */
export class StationDiscover {
  /** Related artists, one Deezer fetch per artist for the whole show. */
  private readonly relatedCache = new Map<number, { id: number; name: string }[]>();
  /** Top tracks, one Deezer fetch per artist for the whole show. */
  private readonly topCache = new Map<
    number,
    { title: string; artist: string; durationSec: number }[]
  >();
  /** Artists whose top list has nothing left to pick this show. */
  private readonly exhaustedArtists = new Set<number>();
  /** Picks a search has taken, so a parallel search does not ask for the same song. */
  private readonly reservedFinds: { artist: string; title: string }[] = [];

  constructor(private readonly deps: StationDiscoverDeps) {}

  /**
   * Related artists the kitchen has not played, then one of their top tracks
   * from YouTube. When that ring runs out, the next ring, then the kitchen
   * artists' own unplayed tops. Up to three searches run at once, and results
   * are kept in candidate order. A cache hit is not a Deezer call. A finds-only
   * set (more than 3) may look further than a mixed one.
   */
  async discover(
    pool: FmSong[],
    genre: GenreId | null,
    allowance: number,
    listenerIds: ReadonlySet<string>,
    index: GenreIndex,
    into?: Track[],
  ): Promise<Track[]> {
    const tracks = into ?? [];
    const catalog = this.deps.catalog;
    if (!catalog || allowance <= 0 || this.deps.ended()) return tracks;
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
    const limit = this.deps.oneSong() ? Math.min(allowance, 1) : allowance;
    const room = (): boolean =>
      !this.deps.ended() &&
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
      if (
        this.deps.ended() ||
        this.exhaustedArtists.has(artistId) ||
        budget.youtube >= youtubeCap
      ) {
        return null;
      }
      const tops = await this.cachedTops(artistId, budget, deezerCap);
      if (!tops || this.deps.ended()) return null;
      const view = this.holding(blocked);
      while (!this.deps.ended() && budget.youtube < youtubeCap) {
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
  async addPlaylist(
    genre: GenreId,
    pool: FmSong[],
    into: Track[],
    allowance: number,
  ): Promise<void> {
    const load = this.deps.genreTracks;
    if (!load || allowance <= 0 || this.deps.ended()) return;
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
    const limit = this.deps.oneSong() ? Math.min(allowance, 1) : allowance;
    const started = into.length;
    await this.runWindow(
      () => {
        if (this.deps.ended() || budget.youtube >= youtubeCap) return null;
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
      if (!found || this.deps.ended()) return;
      if (added() >= allowance || into.length >= SET_MAX) return;
      this.acceptFind(found.pick, found.hit);
      this.deps.place(into, found.hit);
    };

    while (!sourceDone || commit < jobs.length) {
      while (!sourceDone && jobs.length - commit < SEARCH_AT_ONCE) {
        if (this.deps.ended() || added() >= allowance || into.length >= SET_MAX) {
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
    const hit = await this.deps.youtube.searchOne(query, NEW_FIND).catch((error: unknown) => {
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
    if (this.deps.urlTaken(hit.url)) {
      this.rejectFind(pick, blocked, true);
      return null;
    }
    blocked.add(pick);
    return { pick, hit };
  }

  private acceptFind(pick: { artist: string; title: string }, hit: Track): void {
    this.deps.logger.info(`Kitchen FM: new find "${pick.artist} - ${pick.title}".`);
    hit.stationPick = true;
    this.deps.aboutSet(hit, { artist: pick.artist, title: pick.title, by: null, how: 'new' });
    this.deps.rememberFind(hit);
  }

  private rejectFind(
    pick: { artist: string; title: string },
    blocked: BlockedSongs,
    aired: boolean,
  ): void {
    const query = `${pick.artist} - ${pick.title}`;
    this.deps.noteDead(pick.artist, pick.title);
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
      ...this.deps.played().map(splitPlayed),
      ...this.deps.deadList(),
      ...extra,
      ...this.deps.airedRows(),
    ]);
  }
}
