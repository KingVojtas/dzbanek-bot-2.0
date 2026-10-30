import type { GenreId } from './genres';

/**
 * Kitchen FM's genre order. The same list on every server.
 * `other` is a bit of everything: kitchen songs with that genre, or none.
 */
export const GENRE_ROTATION: readonly GenreId[] = [
  'rock',
  'rap',
  'edm',
  'cz-rap',
  'pop',
  'metal',
  'cz-rock',
  'rnb',
  'country',
  'cz-pop',
  'indie',
  'latin',
  'other',
];

/** How long a genre's Deezer playlist stays cached for every server. */
export const GENRE_LIST_MS = 12 * 60 * 60 * 1000;

/** The genre the previous show on this server ended on. Null before the first one. */
export interface RotationCursor {
  genre: GenreId | null;
}

/**
 * The genre that follows `after`. Null is the start of the list, so a fresh
 * server opens with rock. An unknown id also starts at the beginning.
 */
export function rotationAfter(after: GenreId | null): GenreId {
  const first = GENRE_ROTATION[0] ?? 'rock';
  if (!after) return first;
  const at = GENRE_ROTATION.indexOf(after);
  if (at < 0) return first;
  return GENRE_ROTATION[(at + 1) % GENRE_ROTATION.length] ?? first;
}

/**
 * The `/radio play` line. `breakSeconds` of 0 leaves the break out.
 * A whole number of minutes is spoken as minutes.
 */
export function stationPitch(blockSongs: number, breakSeconds: number, genre: string): string {
  const every = `A new genre every ${blockSongs} songs`;
  const first = `First up: ${genre}.`;
  if (breakSeconds <= 0) return `${every}. ${first}`;
  const length = breakSeconds % 60 === 0 ? `${breakSeconds / 60}-minute` : `${breakSeconds}-second`;
  return `${every}, with a ${length} Kitchen FM break in between. ${first}`;
}

/**
 * A cached list, shared by every show. Callers within `maxAgeMs` of a load share
 * it, one still in flight included. An empty or failed load is a failed call and
 * is not kept, so the next set asks again.
 */
export function rememberList<T>(
  cache: Map<string, { at: number; items: Promise<T[]> }>,
  key: string,
  now: number,
  maxAgeMs: number,
  load: () => Promise<T[]>,
): Promise<T[]> {
  const hit = cache.get(key);
  if (hit && now - hit.at < maxAgeMs) return hit.items;
  const entry: { at: number; items: Promise<T[]> } = { at: now, items: Promise.resolve([]) };
  const forget = (): void => {
    if (cache.get(key) === entry) cache.delete(key);
  };
  entry.items = load().then(
    (items) => {
      if (items.length === 0) forget();
      return items;
    },
    () => {
      forget();
      return [];
    },
  );
  cache.set(key, entry);
  return entry.items;
}
