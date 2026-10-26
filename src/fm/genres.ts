import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { catchKeys } from '../radio/now-playing';

/** One shelf Kitchen FM can play for about an hour. */
export const GENRES = [
  { id: 'cz-rap', en: 'Czech rap', cs: 'český rap' },
  { id: 'rap', en: 'rap', cs: 'rap' },
  { id: 'cz-pop', en: 'Czech pop', cs: 'český pop' },
  { id: 'pop', en: 'pop', cs: 'pop' },
  { id: 'rock', en: 'rock', cs: 'rock' },
  { id: 'metal', en: 'metal', cs: 'metal' },
  { id: 'edm', en: 'EDM', cs: 'EDM' },
  { id: 'rnb', en: 'R&B', cs: 'R&B' },
  { id: 'indie', en: 'indie', cs: 'indie' },
  { id: 'latin', en: 'Latin', cs: 'latina' },
  { id: 'other', en: 'a bit of everything', cs: 'od všeho trochu' },
] as const;

export type GenreId = (typeof GENRES)[number]['id'];

/** Genre blocks start once the cache knows this many songs, or this share of the pool. */
export const GENRE_READY_COUNT = 30;
export const GENRE_READY_RATIO = 0.6;

const FAMILIES = ['metal', 'rap', 'edm', 'rnb', 'latin', 'indie', 'rock', 'pop'] as const;
type Family = (typeof FAMILIES)[number];

/** A song the cache already classified. `deezerArtistId` is missing when Deezer had no match. */
export interface CachedSong {
  genre: GenreId;
  deezerArtistId?: number;
}

/** `country` is an ISO code, or "" when MusicBrainz had no country. */
export interface CachedArtist {
  country: string;
}

export interface GenreCacheFile {
  version: 1;
  songs: Record<string, CachedSong>;
  artists: Record<string, CachedArtist>;
}

/** The station's view of the cache: what genre a kitchen song is, and whether blocks may start. */
export interface GenreIndex {
  genreOf(key: string): GenreId | undefined;
  artistId(key: string): number | undefined;
  ready(songs: readonly { key: string }[]): boolean;
  /** Classify keys the cache does not have yet. Returns immediately; the work continues behind the show. */
  enqueue(songs: readonly { key: string; artist: string; title: string }[]): void;
}

/** Empty cache of the current shape. */
export function emptyGenreCache(): GenreCacheFile {
  return { version: 1, songs: {}, artists: {} };
}

/** Normalized artist name, the same way a song key is built. */
export function artistKey(artist: string): string {
  return catchKeys(artist, '').artistKey;
}

/** The genre's name on the card and in the DJ's mouth. */
export function genreName(id: GenreId, language: 'en' | 'cs'): string {
  const genre = GENRES.find((item) => item.id === id);
  return language === 'cs' ? (genre?.cs ?? id) : (genre?.en ?? id);
}

/** True when `id` is one of the fixed genres. */
export function isGenreId(id: string): id is GenreId {
  return GENRES.some((genre) => genre.id === id);
}

/**
 * Map Deezer's genre names and a MusicBrainz country onto one id.
 * Rap or hip hop from Czechia or Slovakia is `cz-rap`; Dance and Electro are `edm`.
 */
export function classifyGenre(names: readonly string[], country: string | null): GenreId {
  const families = new Set<Family>();
  for (const name of names) {
    const family = familyOf(name);
    if (family) families.add(family);
  }
  const family = FAMILIES.find((item) => families.has(item));
  const home = country === 'CZ' || country === 'SK';
  if (family === 'rap') return home ? 'cz-rap' : 'rap';
  if (family === 'pop') return home ? 'cz-pop' : 'pop';
  return family ?? 'other';
}

/** Deezer's genre label. Names may be English or Czech, so marks are stripped first. */
function familyOf(name: string): Family | null {
  const text = name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (text.includes('metal')) return 'metal';
  if (/\brap\b|hip[\s-]?hop|\btrap\b/.test(text)) return 'rap';
  if (
    /dance|tanecn|electro|elektron|\bhouse\b|techno|trance|\bedm\b|dubstep|drum\s*(and|&)\s*bass|\bdnb\b/.test(
      text,
    )
  )
    return 'edm';
  if (/r\s*&\s*b|\brnb\b|soul|funk/.test(text)) return 'rnb';
  if (/latin|reggaeton|salsa|bachata/.test(text)) return 'latin';
  if (/indie|alternativ/.test(text)) return 'indie';
  if (text.includes('rock')) return 'rock';
  if (text.includes('pop')) return 'pop';
  return null;
}

/** True once `known` songs are classified, or at least 60% of the pool. */
export function genresReady(known: number, poolSize: number): boolean {
  if (poolSize <= 0 || known <= 0) return false;
  return known >= GENRE_READY_COUNT || known / poolSize >= GENRE_READY_RATIO;
}

/** How many of `songs` already have a genre. */
export function knownSongs(cache: GenreCacheFile, songs: readonly { key: string }[]): number {
  return songs.filter((song) => cache.songs[song.key]).length;
}

/** Read the cache. A missing or broken file is an empty cache, not a failed show. */
export function readGenreCache(path: string): GenreCacheFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GenreCacheFile>;
    if (raw.version !== 1 || !raw.songs || !raw.artists) return emptyGenreCache();
    return { version: 1, songs: raw.songs, artists: raw.artists };
  } catch {
    return emptyGenreCache();
  }
}

/** Write the cache by renaming a temp file over the old one. */
export function writeGenreCache(path: string, cache: GenreCacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  try {
    rmSync(path, { force: true });
  } catch {
    // The destination may not exist yet.
  }
  renameSync(tmp, path);
}
