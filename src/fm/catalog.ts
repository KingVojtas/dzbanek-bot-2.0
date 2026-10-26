import { isSameSong } from './script';

/**
 * Free catalog lookups. Deezer's public API (`https://api.deezer.com`) needs no key.
 * Its guideline pages do not publish a number without a login; clients document a ceiling
 * of 50 requests per 5 seconds, so this client stays at 4 per second.
 * MusicBrainz (`/ws/2/artist`, `fmt=json`) asks for at most one request a second and a
 * contactable User-Agent. A failed call returns nothing. The show does not stop for it.
 */
const DEEZER = 'https://api.deezer.com';
const MUSICBRAINZ = 'https://musicbrainz.org/ws/2/artist';
const USER_AGENT = 'dzbanek-bot/2.0 (https://github.com/KingVojtas/dzbanek-bot-2.0)';
const DEEZER_GAP_MS = 250;
/** Deezer translates genre names. English keeps them on the map in `familyOf`. */
const DEEZER_HEADERS = { 'Accept-Language': 'en' };
const MUSICBRAINZ_GAP_MS = 1_100;

/** A Deezer track that matched the kitchen's artist and title. */
export interface DeezerHit {
  title: string;
  artist: string;
  albumId: number;
  artistId: number;
}

/** One track from an artist's Deezer top list. */
export interface DeezerTop {
  title: string;
  artist: string;
  durationSec: number;
}

/** A lookup that reached the server. `hit` or `country` null means the catalog had no match. */
export type QuietOk<T> = { ok: true; value: T };
/** The call timed out, was refused, or came back as an error. Try again another show. */
export type QuietFail = { ok: false };
export type Quiet<T> = QuietOk<T> | QuietFail;

/** What the station asks Deezer and MusicBrainz. */
export interface FmCatalog {
  /** The first Deezer hit `isSameSong` accepts. `value` null means Deezer had no such song. */
  searchTrack(artist: string, title: string): Promise<Quiet<DeezerHit | null>>;
  /** Genre names on a Deezer album. */
  albumGenres(albumId: number): Promise<Quiet<string[]>>;
  /** Artists Deezer lists as related. Empty on failure. */
  relatedArtists(artistId: number): Promise<{ id: number; name: string }[]>;
  /** An artist's top tracks. Empty on failure. */
  topTracks(artistId: number): Promise<DeezerTop[]>;
  /** ISO country from MusicBrainz. `value` null means no matching artist with a country. */
  artistCountry(name: string): Promise<Quiet<string | null>>;
}

interface Gate {
  slot(): Promise<void>;
}

/** One request at a time, at least `gapMs` after the previous one. */
export function createGate(gapMs: number, now: () => number = Date.now): Gate {
  let chain: Promise<void> = Promise.resolve();
  let nextAt = 0;
  return {
    slot() {
      const run = chain.then(async () => {
        const wait = Math.max(0, nextAt - now());
        if (wait > 0) await delay(wait);
        nextAt = now() + gapMs;
      });
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Deezer puts errors in the JSON body as well as in the status. */
export function deezerFailed(body: unknown): boolean {
  const root = record(body);
  return !root || 'error' in root;
}

/**
 * The first search hit that is the named song. Null when Deezer returned tracks
 * and none matched; the caller treats a thrown fetch as "try again later".
 */
export function deezerHitFromSearch(
  body: unknown,
  want: { artist: string; title: string },
): DeezerHit | null {
  if (deezerFailed(body)) return null;
  const data = record(body)?.data;
  if (!Array.isArray(data)) return null;
  for (const item of data.slice(0, 8)) {
    const row = record(item);
    const artist = record(row?.artist);
    const album = record(row?.album);
    const title = text(row?.title);
    const artistName = text(artist?.name);
    const albumId = num(album?.id);
    const artistId = num(artist?.id);
    if (!title || !artistName || albumId === null || artistId === null) continue;
    if (!isSameSong(want, { title, uploader: artistName })) continue;
    return { title, artist: artistName, albumId, artistId };
  }
  return null;
}

/** Genre names on a Deezer album payload. */
export function genreNamesFromAlbum(body: unknown): string[] {
  if (deezerFailed(body)) return [];
  const data = record(record(body)?.genres)?.data;
  if (!Array.isArray(data)) return [];
  return data.map((item) => text(record(item)?.name)).filter(Boolean);
}

/** Related artists on a Deezer payload. */
export function relatedFromBody(body: unknown): { id: number; name: string }[] {
  if (deezerFailed(body)) return [];
  const data = record(body)?.data;
  if (!Array.isArray(data)) return [];
  const artists: { id: number; name: string }[] = [];
  for (const item of data) {
    const row = record(item);
    const id = num(row?.id);
    const name = text(row?.name);
    if (id === null || !name) continue;
    artists.push({ id, name });
  }
  return artists;
}

/** Top tracks on a Deezer payload. Duration is seconds. */
export function topsFromBody(body: unknown): DeezerTop[] {
  if (deezerFailed(body)) return [];
  const data = record(body)?.data;
  if (!Array.isArray(data)) return [];
  const tops: DeezerTop[] = [];
  for (const item of data) {
    const row = record(item);
    const artist = text(record(row?.artist)?.name);
    const title = text(row?.title);
    const durationSec = num(row?.duration);
    if (!artist || !title || durationSec === null) continue;
    tops.push({ title, artist, durationSec });
  }
  return tops;
}

/**
 * The country of the artist whose name matches, from a MusicBrainz artist search.
 * Uses `country` when it is set, otherwise the area's ISO code.
 */
export function countryFromSearch(body: unknown, artist: string): string | null {
  const artists = record(body)?.artists;
  if (!Array.isArray(artists)) return null;
  const want = artistKeyOf(artist);
  let best: { score: number; country: string } | null = null;
  for (const item of artists) {
    const row = record(item);
    if (!row || artistKeyOf(text(row.name)) !== want) continue;
    const score = scoreOf(row.score);
    const country = countryOf(row);
    if (!country) continue;
    if (!best || score > best.score) best = { score, country };
  }
  return best?.country ?? null;
}

function artistKeyOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreOf(value: unknown): number {
  const score = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(score) ? score : 0;
}

function countryOf(artist: Record<string, unknown>): string | null {
  const direct = text(artist.country).toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  const codes = record(artist.area)?.['iso-3166-1-codes'];
  const code = Array.isArray(codes) ? text(codes[0]).toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Lucene-safe artist query: `artist:"Name"`. */
export function musicBrainzQuery(artist: string): string {
  return `artist:"${artist.replace(/["\\]/g, ' ')}"`;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Deezer and MusicBrainz, throttled, failing quiet. */
export function createCatalog(fetchImpl: typeof fetch = fetch): FmCatalog {
  const deezer = createGate(DEEZER_GAP_MS);
  const musicBrainz = createGate(MUSICBRAINZ_GAP_MS);
  return {
    async searchTrack(artist, title) {
      await deezer.slot();
      // The documented artist:"…" track:"…" filter currently comes back empty
      // (checked 2026-10-26, including Deezer's own example). Quoted names still
      // rank the song first, and isSameSong drops the rest.
      const query = `"${artist.replace(/"/g, '')}" "${title.replace(/"/g, '')}"`;
      const body = await getJson(
        fetchImpl,
        `${DEEZER}/search?q=${encodeURIComponent(query)}`,
        DEEZER_HEADERS,
      );
      if (!body || deezerFailed(body)) return { ok: false };
      return { ok: true, value: deezerHitFromSearch(body, { artist, title }) };
    },
    async albumGenres(albumId) {
      await deezer.slot();
      const body = await getJson(fetchImpl, `${DEEZER}/album/${albumId}`, DEEZER_HEADERS);
      if (!body || deezerFailed(body)) return { ok: false };
      return { ok: true, value: genreNamesFromAlbum(body) };
    },
    async relatedArtists(artistId) {
      await deezer.slot();
      const body = await getJson(fetchImpl, `${DEEZER}/artist/${artistId}/related`, DEEZER_HEADERS);
      return body ? relatedFromBody(body) : [];
    },
    async topTracks(artistId) {
      await deezer.slot();
      const body = await getJson(
        fetchImpl,
        `${DEEZER}/artist/${artistId}/top?limit=10`,
        DEEZER_HEADERS,
      );
      return body ? topsFromBody(body) : [];
    },
    async artistCountry(name) {
      await musicBrainz.slot();
      const url = `${MUSICBRAINZ}?query=${encodeURIComponent(musicBrainzQuery(name))}&fmt=json&limit=5`;
      const body = await getJson(fetchImpl, url, {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      });
      if (!body) return { ok: false };
      return { ok: true, value: countryFromSearch(body, name) };
    },
  };
}
