import { join } from 'node:path';
import type { Logger } from '../core/logger';
import type { FmCatalog } from './catalog';
import {
  artistKey,
  classifyGenre,
  genresReady,
  isGenreId,
  knownSongs,
  readGenreCache,
  songNeedsLookup,
  tagsHaveCounts,
  writeGenreCache,
  type CachedSong,
  type GenreCacheFile,
  type GenreId,
  type GenreIndex,
  type TagVote,
} from './genres';

/** `data/fm-genres.json` in the process working directory. Deploys leave `data/` in place. */
export function genreCachePath(): string {
  return join(process.cwd(), 'data', 'fm-genres.json');
}

/**
 * The genre cache and the queue that fills it. Lookups run behind the show:
 * a failed call leaves the song unknown, and the station keeps playing.
 */
export class GenreBook implements GenreIndex {
  private cache: GenreCacheFile;
  private readonly pending: { key: string; artist: string; title: string }[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private lastPool: { key: string }[] = [];

  constructor(
    private readonly path: string,
    private readonly catalog: FmCatalog,
    private readonly logger: Logger,
    cache?: GenreCacheFile,
    private readonly now: () => number = Date.now,
  ) {
    this.cache = cache ?? readGenreCache(path);
    if (this.remapStored()) this.persist();
  }

  /** The cache as it stands, for tests and the startup log. */
  snapshot(): GenreCacheFile {
    return this.cache;
  }

  genreOf(key: string): GenreId | undefined {
    const genre = this.cache.songs[key]?.genre;
    return genre && isGenreId(genre) ? genre : undefined;
  }

  artistId(key: string): number | undefined {
    const id = this.cache.songs[key]?.deezerArtistId;
    return typeof id === 'number' ? id : undefined;
  }

  ready(songs: readonly { key: string }[]): boolean {
    return genresReady(knownSongs(this.cache, songs), songs.length);
  }

  enqueue(songs: readonly { key: string; artist: string; title: string }[]): void {
    this.lastPool = songs.map((song) => ({ key: song.key }));
    const now = this.now();
    for (const song of songs) {
      if (!song.key || !song.title || this.queued.has(song.key)) continue;
      const cached = this.cache.songs[song.key];
      const artist = cached?.deezerArtist
        ? this.cache.artists[artistKey(cached.deezerArtist)]
        : undefined;
      if (!songNeedsLookup(cached, artist, now)) continue;
      this.queued.add(song.key);
      this.pending.push(song);
    }
    this.report();
    if (!this.running && this.pending.length > 0) void this.pump();
  }

  private report(): void {
    const known = knownSongs(this.cache, this.lastPool);
    this.logger.info(`Kitchen FM genres: ${known}/${this.lastPool.length} songs known.`);
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const song = this.pending.shift()!;
        try {
          const learned = await this.classify(song);
          if (learned) {
            this.cache.songs[song.key] = learned;
            this.persist();
          }
        } catch (error) {
          this.logger.debug('Kitchen FM genres: lookup failed:', error);
        } finally {
          this.queued.delete(song.key);
        }
      }
    } finally {
      this.running = false;
      this.report();
      if (this.pending.length > 0) void this.pump();
    }
  }

  /**
   * One song. Null means try the whole lookup later.
   * A Deezer hit is kept when MusicBrainz is busy, so the next pass skips Deezer.
   * A miss stores `missedAt` and is not filed as `other`.
   */
  private async classify(song: {
    key: string;
    artist: string;
    title: string;
  }): Promise<CachedSong | null> {
    const existing = this.cache.songs[song.key];
    const held = existing?.deezerArtist ? existing : undefined;
    let deezerArtist = held?.deezerArtist;
    let deezerArtistId = held?.deezerArtistId;
    let deezerAlbumId = held?.deezerAlbumId;
    let deezerGenres = held?.deezerGenres;

    if (!deezerGenres) {
      if (!deezerArtist || deezerAlbumId === undefined) {
        const search = await this.catalog.searchTrack(song.artist, song.title);
        if (!search.ok) return null;
        if (!search.value) return { missedAt: new Date(this.now()).toISOString() };
        deezerArtist = search.value.artist;
        deezerArtistId = search.value.artistId;
        deezerAlbumId = search.value.albumId;
      }
      const album = await this.catalog.albumGenres(deezerAlbumId);
      if (!album.ok) {
        return { deezerArtist, deezerArtistId, deezerAlbumId, genre: existing?.genre };
      }
      deezerGenres = album.value;
    }

    const facts = await this.factsFor(deezerArtist ?? '');
    const stored: CachedSong = { deezerArtist, deezerArtistId, deezerAlbumId, deezerGenres };
    if (!facts) return { ...stored, genre: existing?.genre };
    return {
      ...stored,
      genre: classifyGenre(deezerGenres, facts.country, facts.tags),
    };
  }

  /**
   * Cached country and tag votes for the Deezer artist name.
   * Undefined when MusicBrainz did not answer. A stored row with no `tags`
   * array, or with names and no vote counts, is asked once.
   */
  private async factsFor(
    artist: string,
  ): Promise<{ country: string | null; tags: TagVote[] } | undefined> {
    const key = artistKey(artist);
    if (!key) return { country: null, tags: [] };
    const cached = this.cache.artists[key];
    // `[]` means MusicBrainz answered and had no tags. Bare names have no counts yet.
    if (tagsHaveCounts(cached?.tags)) return { country: cached.country || null, tags: cached.tags };
    const result = await this.catalog.artistCountry(artist);
    if (!result.ok) return undefined;
    let country = result.value.country ?? (cached?.country || null);
    const areaIds = result.value.areaIds ?? [];
    if (!country && areaIds.length > 0) {
      const found = await this.countryFromAreas(areaIds);
      if (found === undefined) return undefined;
      country = found;
    }
    const tags = result.value.tags ?? [];
    this.cache.artists[key] = { country: country ?? '', tags };
    return { country, tags };
  }

  /**
   * Walk "part of" from a city up to a country. Undefined when a lookup failed,
   * so the artist is asked again later. A finished walk with no country is null.
   * Each area id is remembered, including the ones along the way.
   */
  private async countryFromAreas(ids: readonly string[]): Promise<string | null | undefined> {
    const pending = [...ids];
    const seen = new Set<string>();
    const walked: string[] = [];
    while (pending.length > 0 && walked.length < 8) {
      const id = pending.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const saved = this.cache.areas?.[id];
      if (typeof saved === 'string') {
        if (saved) {
          this.rememberAreas(walked, saved);
          return saved;
        }
        continue;
      }
      const lookup = await this.catalog.lookupArea(id);
      if (!lookup.ok) return undefined;
      walked.push(id);
      if (lookup.value.country) {
        this.rememberAreas(walked, lookup.value.country);
        return lookup.value.country;
      }
      const known = lookup.value.parents.find((parent) => parent.country);
      if (known?.country) {
        this.rememberAreas([...walked, known.id], known.country);
        return known.country;
      }
      for (const parent of lookup.value.parents) pending.push(parent.id);
    }
    this.rememberAreas([...seen], '');
    return null;
  }

  private rememberAreas(ids: readonly string[], country: string): void {
    this.cache.areas ??= {};
    for (const id of ids) {
      if (id) this.cache.areas[id] = country;
    }
  }

  /** Apply the current mapping to rows that already stored Deezer's labels. */
  private remapStored(): boolean {
    let changed = false;
    for (const song of Object.values(this.cache.songs)) {
      if (!song.deezerGenres) continue;
      const artist = song.deezerArtist
        ? this.cache.artists[artistKey(song.deezerArtist)]
        : undefined;
      const tags = tagsHaveCounts(artist?.tags) ? artist.tags : [];
      const genre = classifyGenre(song.deezerGenres, artist?.country || null, tags);
      if (song.genre !== genre) {
        song.genre = genre;
        changed = true;
      }
    }
    return changed;
  }

  private persist(): void {
    try {
      writeGenreCache(this.path, this.cache);
    } catch (error) {
      this.logger.warn('Kitchen FM genres: could not save the cache:', error);
    }
  }
}
