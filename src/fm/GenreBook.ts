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
  writeGenreCache,
  type GenreCacheFile,
  type GenreId,
  type GenreIndex,
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
  ) {
    this.cache = cache ?? readGenreCache(path);
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
    for (const song of songs) {
      if (!song.key || !song.title || this.cache.songs[song.key] || this.queued.has(song.key)) {
        continue;
      }
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

  /** One song. Null means try again later; a stored `other` means the catalog had nothing. */
  private async classify(song: {
    artist: string;
    title: string;
  }): Promise<GenreCacheFile['songs'][string] | null> {
    const search = await this.catalog.searchTrack(song.artist, song.title);
    if (!search.ok) return null;
    if (!search.value) return { genre: 'other' };

    const album = await this.catalog.albumGenres(search.value.albumId);
    if (!album.ok) return null;
    const country = await this.countryFor(song.artist);
    if (country === undefined) return null;
    return {
      genre: classifyGenre(album.value, country),
      deezerArtistId: search.value.artistId,
    };
  }

  /** Cached country, null when MusicBrainz has none, undefined when the call failed. */
  private async countryFor(artist: string): Promise<string | null | undefined> {
    const key = artistKey(artist);
    if (!key) return null;
    const cached = this.cache.artists[key];
    if (cached) return cached.country || null;
    const result = await this.catalog.artistCountry(artist);
    if (!result.ok) return undefined;
    this.cache.artists[key] = { country: result.value ?? '' };
    return result.value;
  }

  private persist(): void {
    try {
      writeGenreCache(this.path, this.cache);
    } catch (error) {
      this.logger.warn('Kitchen FM genres: could not save the cache:', error);
    }
  }
}
