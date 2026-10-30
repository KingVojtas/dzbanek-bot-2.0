import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { catchKeys } from '../radio/now-playing';

/**
 * One shelf Kitchen FM can play for a block of songs.
 * `query` is the Deezer playlist search for a genre the kitchen has not played.
 * `other` has none. That block is kitchen songs tagged `other`, or not tagged at all.
 */
export const GENRES = [
  { id: 'cz-rap', en: 'Czech rap', cs: 'český rap', query: 'český rap' },
  { id: 'rap', en: 'rap', cs: 'rap', query: 'rap hits' },
  { id: 'cz-pop', en: 'Czech pop', cs: 'český pop', query: 'český pop' },
  { id: 'pop', en: 'pop', cs: 'pop', query: 'pop hits' },
  { id: 'cz-rock', en: 'Czech rock', cs: 'český rock', query: 'český rock' },
  { id: 'rock', en: 'rock', cs: 'rock', query: 'rock classics' },
  { id: 'metal', en: 'metal', cs: 'metal', query: 'metal hits' },
  { id: 'edm', en: 'EDM', cs: 'EDM', query: 'edm hits' },
  { id: 'rnb', en: 'R&B', cs: 'R&B', query: 'r&b hits' },
  { id: 'indie', en: 'indie', cs: 'indie', query: 'indie hits' },
  { id: 'latin', en: 'Latin', cs: 'latina', query: 'latin hits' },
  { id: 'country', en: 'country', cs: 'country', query: 'country hits' },
  { id: 'other', en: 'a bit of everything', cs: 'od všeho trochu' },
] as const;

export type GenreId = (typeof GENRES)[number]['id'];

/** Genre blocks start once the cache knows this many songs, or this share of the pool. */
export const GENRE_READY_COUNT = 30;
export const GENRE_READY_RATIO = 0.6;

const FAMILIES = [
  'metal',
  'rap',
  'edm',
  'rnb',
  'latin',
  'country',
  'indie',
  'rock',
  'pop',
] as const;
type Family = (typeof FAMILIES)[number];

/** How long a Deezer miss stays quiet before the song is looked up again. */
export const GENRE_MISS_MS = 7 * 86_400_000;

/**
 * A song the cache has looked at.
 * `genre` is missing until Deezer and MusicBrainz both answered.
 * `deezerGenres` is the raw album labels, so a mapping change needs no network.
 * `missedAt` is an ISO time when Deezer had no such song. It is tried again after 7 days.
 */
export interface CachedSong {
  genre?: GenreId;
  deezerArtistId?: number;
  /** Main artist on the Deezer hit, not the YouTube title credit. */
  deezerArtist?: string;
  deezerAlbumId?: number;
  deezerGenres?: string[];
  missedAt?: string;
}

/** One MusicBrainz tag and how many people voted for it. */
export interface TagVote {
  name: string;
  count: number;
}

/**
 * `country` is an ISO code, or "" when MusicBrainz had no country.
 * `tags` is omitted on caches written before tags were stored.
 * A list of plain names is the shape from before vote counts, and is asked once more.
 */
export interface CachedArtist {
  country: string;
  tags?: TagVote[] | string[];
}

export interface GenreCacheFile {
  version: 1;
  songs: Record<string, CachedSong>;
  artists: Record<string, CachedArtist>;
  /** Area MBID → ISO country, or "" when the walk found none. Omitted on older files. */
  areas?: Record<string, string>;
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
  return { version: 1, songs: {}, artists: {}, areas: {} };
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

/** Deezer playlist search for this genre. `other` has none. */
export function genreQuery(id: GenreId): string | null {
  const genre = GENRES.find((item) => item.id === id);
  return genre && 'query' in genre ? genre.query : null;
}

/**
 * Words a playlist title must hold to be used for a genre, matched without
 * accents. Deezer's search for "český pop" ranks "CZ/SK Rap" first.
 */
const PLAYLIST_WORDS: Partial<Record<GenreId, RegExp>> = {
  'cz-rap': /\brap\b|hip.?hop/,
  rap: /\brap\b|hip.?hop|urban/,
  'cz-pop': /\bpop\b/,
  pop: /\bpop\b|hits/,
  'cz-rock': /rock|punk/,
  rock: /rock/,
  metal: /metal/,
  edm: /\bedm\b|dance|electro|house|techno/,
  rnb: /r&b|\brnb\b|soul/,
  indie: /indie|alternative/,
  latin: /latin|reggaeton|salsa|bachata/,
  country: /country/,
};

/** Whether a Deezer playlist's title names `id`. A genre without words takes any title. */
export function playlistFits(id: GenreId, title: string): boolean {
  const words = PLAYLIST_WORDS[id];
  if (!words) return true;
  return words.test(title.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''));
}

/** True when `id` is one of the fixed genres. */
export function isGenreId(id: string): id is GenreId {
  return GENRES.some((genre) => genre.id === id);
}

/**
 * Map Deezer's genre names, MusicBrainz tag votes, and a country onto one id.
 * Rap or hip hop from Czechia or Slovakia is `cz-rap`. Rock from there is `cz-rock`.
 * Dance and Electro are `edm`. "Alternative" is rock. Country beats rock and pop
 * when both labels are on the album. Tag votes replace the album label only when
 * one family has at least 2 votes and more than every other family.
 */
export function classifyGenre(
  names: readonly string[],
  country: string | null,
  tags: readonly TagVote[] = [],
): GenreId {
  const family = votedFamily(tags) ?? strongest(names);
  const home = country === 'CZ' || country === 'SK';
  if (family === 'rap') return home ? 'cz-rap' : 'rap';
  if (family === 'pop') return home ? 'cz-pop' : 'pop';
  if (family === 'rock') return home ? 'cz-rock' : 'rock';
  return family ?? 'other';
}

/**
 * The family with the most tag votes, when that lead is clear.
 * A tie, or a winner with a single vote, leaves the album label in charge.
 */
function votedFamily(tags: readonly TagVote[]): Family | null {
  const sums = new Map<Family, number>();
  for (const tag of tags) {
    const family = familyOf(tag.name);
    if (!family || !Number.isFinite(tag.count) || tag.count <= 0) continue;
    sums.set(family, (sums.get(family) ?? 0) + tag.count);
  }
  let best: Family | null = null;
  let bestCount = 0;
  let runnerUp = 0;
  for (const [family, count] of sums) {
    if (count > bestCount) {
      runnerUp = bestCount;
      best = family;
      bestCount = count;
    } else if (count > runnerUp) {
      runnerUp = count;
    }
  }
  if (!best || bestCount < 2 || bestCount <= runnerUp) return null;
  return best;
}

/** The highest-priority family named in `labels`. */
function strongest(labels: readonly string[]): Family | null {
  const found = new Set<Family>();
  for (const label of labels) {
    const family = familyOf(label);
    if (family) found.add(family);
  }
  return FAMILIES.find((item) => found.has(item)) ?? null;
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
  if (/\bcountry\b|americana|bluegrass/.test(text)) return 'country';
  if (text.includes('indie')) return 'indie';
  if (text.includes('alternativ') || text.includes('rock')) return 'rock';
  if (text.includes('pop')) return 'pop';
  return null;
}

/** True when every tag is a `{ name, count }` vote. A list of bare names is the old shape. */
export function tagsHaveCounts(tags: CachedArtist['tags']): tags is TagVote[] {
  if (!Array.isArray(tags)) return false;
  return tags.every(
    (tag) =>
      !!tag &&
      typeof tag === 'object' &&
      typeof tag.name === 'string' &&
      typeof tag.count === 'number',
  );
}

/**
 * True when this cache row still needs a lookup.
 * A Deezer miss waits 7 days. A row from the old mapping has no raw genres yet.
 * An artist saved before tags existed, or with names and no vote counts, is asked once more.
 */
export function songNeedsLookup(
  song: CachedSong | undefined,
  artist: CachedArtist | undefined,
  now: number,
): boolean {
  if (!song) return true;
  if (song.missedAt) {
    const at = Date.parse(song.missedAt);
    return !Number.isFinite(at) || now - at >= GENRE_MISS_MS;
  }
  if (!song.deezerGenres || !song.genre) return true;
  return !!song.deezerArtist && !tagsHaveCounts(artist?.tags);
}

/** True once `known` songs are classified, or at least 60% of the pool. */
export function genresReady(known: number, poolSize: number): boolean {
  if (poolSize <= 0 || known <= 0) return false;
  return known >= GENRE_READY_COUNT || known / poolSize >= GENRE_READY_RATIO;
}

/** How many of `songs` already have a genre. */
export function knownSongs(cache: GenreCacheFile, songs: readonly { key: string }[]): number {
  return songs.filter((song) => {
    const genre = cache.songs[song.key]?.genre;
    return !!genre && isGenreId(genre);
  }).length;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const areas: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') areas[key] = item;
  }
  return areas;
}

/** Read the cache. A missing or broken file is an empty cache, not a failed show. */
export function readGenreCache(path: string): GenreCacheFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GenreCacheFile>;
    if (raw.version !== 1 || !raw.songs || !raw.artists) return emptyGenreCache();
    return { version: 1, songs: raw.songs, artists: raw.artists, areas: stringMap(raw.areas) };
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
