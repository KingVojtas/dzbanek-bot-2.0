import type { TagVote } from './genres';
import { isSameSong } from './script';

/**
 * Free catalog lookups. Deezer's public API (`https://api.deezer.com`) needs no key.
 * Its guideline pages do not publish a number without a login; clients document a ceiling
 * of 50 requests per 5 seconds, so this client stays at 4 per second.
 * MusicBrainz (`/ws/2/artist`, `fmt=json`) asks for at most one request a second and a
 * contactable User-Agent. A failed call returns nothing. The show does not stop for it.
 */
const DEEZER = 'https://api.deezer.com';
const MUSICBRAINZ_ROOT = 'https://musicbrainz.org/ws/2';
const MUSICBRAINZ = `${MUSICBRAINZ_ROOT}/artist`;
const AREA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_AGENT = 'dzbanek-bot/2.0 (https://github.com/KingVojtas/dzbanek-bot-2.0)';
const DEEZER_GAP_MS = 250;
/** Top tracks kept per artist. Ten was too few to fill a set the station had not aired. */
const DEEZER_TOP_LIMIT = 25;
/** Deezer translates genre names. English keeps them on the map in `familyOf`. */
const DEEZER_HEADERS = { 'Accept-Language': 'en' };
const MUSICBRAINZ_GAP_MS = 1_100;
/** A busy MusicBrainz answers 503. Try again after this, at most twice. */
export const MB_RETRY_MS = 3_000;
export const MB_RETRIES = 2;

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

/** Country and tag votes from one MusicBrainz artist search. */
export interface ArtistProfile {
  country: string | null;
  tags: TagVote[];
  /**
   * Area and begin-area ids that had no ISO code. The book walks these
   * with `lookupArea` when `country` is still null.
   */
  areaIds?: string[];
}

/** One step up from an area lookup. A backward "part of" relation points at the parent. */
export interface AreaStep {
  country: string | null;
  parents: { id: string; country: string | null }[];
}

/** A lookup that reached the server. `hit` null means the catalog had no match. */
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
  /**
   * Country and tags for one artist. `ok: false` means MusicBrainz did not answer
   * (a 503 is tried again after 3 seconds, at most twice).
   */
  artistCountry(name: string): Promise<Quiet<ArtistProfile>>;
  /**
   * `/ws/2/area/<id>?inc=area-rels&fmt=json`. `ok: false` means MusicBrainz did not answer.
   * The same one-request-a-second gate as the artist search.
   */
  lookupArea(id: string): Promise<Quiet<AreaStep>>;
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
 * Country and tag votes of the artist whose name matches a MusicBrainz search.
 * Country uses `country`, then the area's ISO code, then the begin-area's.
 * Areas with no ISO code are returned as `areaIds` so the caller can walk them.
 * An empty profile means the search answered and nobody had that name.
 */
export function artistFromSearch(body: unknown, artist: string): ArtistProfile | null {
  const artists = record(body)?.artists;
  if (!Array.isArray(artists)) return null;
  const want = artistKeyOf(artist);
  let best: { score: number; row: Record<string, unknown> } | null = null;
  for (const item of artists) {
    const row = record(item);
    if (!row || artistKeyOf(text(row.name)) !== want) continue;
    const score = scoreOf(row.score);
    if (!best || score > best.score) best = { score, row };
  }
  if (!best) return { country: null, tags: [], areaIds: [] };
  const country = countryOf(best.row);
  return { country, tags: tagsOf(best.row), areaIds: country ? [] : areaIdsOf(best.row) };
}

/**
 * One area lookup (`/ws/2/area/<id>?inc=area-rels&fmt=json`).
 * Area-area "part of" (de7cc874-8b1b-3a05-8272-f3834c968fb7): the reverse phrase
 * is "part of", so `direction: "backward"` is the area this one sits inside.
 * `forward` means "has part" — an area inside this one — and is left out.
 * A missing direction is the old forward shape and is left out too.
 */
export function areaStepFromLookup(body: unknown): AreaStep | null {
  const root = record(body);
  if (!root || 'error' in root || !text(root.id)) return null;
  const parents: AreaStep['parents'] = [];
  if (Array.isArray(root.relations)) {
    for (const item of root.relations) {
      const rel = record(item);
      if (!rel || text(rel.type).toLowerCase() !== 'part of') continue;
      if (text(rel.direction).toLowerCase() !== 'backward') continue;
      const parent = record(rel.area);
      const id = text(parent?.id);
      if (!AREA_ID.test(id)) continue;
      parents.push({ id, country: isoOf(parent) });
    }
  }
  return { country: isoOf(root), parents };
}

/** The country of the artist whose name matches, from a MusicBrainz artist search. */
export function countryFromSearch(body: unknown, artist: string): string | null {
  return artistFromSearch(body, artist)?.country ?? null;
}

function tagsOf(artist: Record<string, unknown>): TagVote[] {
  const tags = artist.tags;
  if (!Array.isArray(tags)) return [];
  const votes: TagVote[] = [];
  for (const item of tags) {
    const row = record(item);
    const name = text(row?.name);
    const count = countOf(row?.count);
    if (!name || count === null) continue;
    votes.push({ name, count });
  }
  return votes;
}

function countOf(value: unknown): number | null {
  const count = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(count) || count < 0) return null;
  return count;
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
  return isoOf(record(artist.area)) ?? isoOf(record(artist['begin-area']));
}

function isoOf(area: Record<string, unknown> | null): string | null {
  if (!area) return null;
  const codes = area['iso-3166-1-codes'];
  const code = Array.isArray(codes) ? text(codes[0]).toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Area and begin-area ids that still need a "part of" walk. */
function areaIdsOf(artist: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ['area', 'begin-area']) {
    const area = record(artist[key]);
    if (!area || isoOf(area)) continue;
    const id = text(area.id);
    if (!AREA_ID.test(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** Lucene-safe artist query: `artist:"Name"`. */
export function musicBrainzQuery(artist: string): string {
  return `artist:"${artist.replace(/["\\]/g, ' ')}"`;
}

/**
 * One MusicBrainz search. A 503 waits `MB_RETRY_MS` and tries again, at most `MB_RETRIES` times.
 * Any other failure returns null so the caller can try on a later show.
 */
export async function fetchMusicBrainz(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  beforeEach: () => Promise<void>,
  wait: (ms: number) => Promise<void>,
): Promise<unknown | null> {
  for (let attempt = 0; attempt <= MB_RETRIES; attempt += 1) {
    await beforeEach();
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch {
      return null;
    }
    if (response.status === 503 && attempt < MB_RETRIES) {
      await wait(MB_RETRY_MS);
      continue;
    }
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
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
        `${DEEZER}/artist/${artistId}/top?limit=${DEEZER_TOP_LIMIT}`,
        DEEZER_HEADERS,
      );
      return body ? topsFromBody(body) : [];
    },
    async artistCountry(name) {
      const url = `${MUSICBRAINZ}?query=${encodeURIComponent(musicBrainzQuery(name))}&fmt=json&limit=5`;
      const body = await fetchMusicBrainz(
        fetchImpl,
        url,
        { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        () => musicBrainz.slot(),
        delay,
      );
      const profile = body ? artistFromSearch(body, name) : null;
      if (!profile) return { ok: false };
      return { ok: true, value: profile };
    },
    async lookupArea(id) {
      if (!AREA_ID.test(id)) return { ok: true, value: { country: null, parents: [] } };
      const body = await fetchMusicBrainz(
        fetchImpl,
        `${MUSICBRAINZ_ROOT}/area/${id}?inc=area-rels&fmt=json`,
        { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        () => musicBrainz.slot(),
        delay,
      );
      const step = body ? areaStepFromLookup(body) : null;
      if (!step) return { ok: false };
      return { ok: true, value: step };
    },
  };
}
