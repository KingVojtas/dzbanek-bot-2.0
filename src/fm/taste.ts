import type { GenreId } from './genres';
import { SET_MAX, isSameSong, sampleCrate, songFits, type FmSong } from './script';

/** A play from 30 days ago weighs half of one from today. */
export const TASTE_HALF_LIFE_MS = 30 * 86_400_000;

/**
 * How much the server wants each genre. A catch weighs half a play, and a song
 * brought by someone listening now weighs 1.5×. `other` and songs with no genre
 * do not pull a block.
 */
export function tasteProfile(
  pool: readonly FmSong[],
  genreOf: (song: FmSong) => GenreId | undefined,
  opts: { now: number; listenerIds: ReadonlySet<string> },
): Map<GenreId, number> {
  const weights = new Map<GenreId, number>();
  for (const song of pool) {
    const genre = genreOf(song);
    if (!genre || genre === 'other' || !songFits(song.durationSec)) continue;
    const age = Math.max(0, opts.now - song.at.getTime());
    let weight = 0.5 ** (age / TASTE_HALF_LIFE_MS);
    if (song.from.kind === 'catch') weight *= 0.5;
    if (song.from.userId && opts.listenerIds.has(song.from.userId)) weight *= 1.5;
    weights.set(genre, (weights.get(genre) ?? 0) + weight);
  }
  return weights;
}

/**
 * The next block's genre. The first of a show is the heaviest. After that, a
 * weighted draw that leaves out the genre just played, unless it is the only one.
 */
export function nextGenre(
  profile: ReadonlyMap<GenreId, number>,
  history: readonly GenreId[],
  rng: () => number,
): GenreId | null {
  const ranked = [...profile.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return null;
  if (history.length === 0) return ranked[0]![0];
  const last = history[history.length - 1];
  const choices = ranked.filter(([id]) => id !== last);
  return weightedPick(choices.length > 0 ? choices : ranked, rng);
}

function weightedPick(choices: [GenreId, number][], rng: () => number): GenreId {
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let mark = rng() * total;
  for (const [id, weight] of choices) {
    mark -= weight;
    if (mark <= 0) return id;
  }
  return choices[choices.length - 1]![0];
}

/**
 * Kitchen songs of one genre for a set, never one that played recently. Empty
 * when the genre has run out, so the block moves on instead of repeating itself.
 */
export function genreSongs<T extends FmSong>(
  pool: readonly T[],
  recent: readonly string[],
  genre: GenreId,
  genreOf: (song: T) => GenreId | undefined,
  rng: () => number = Math.random,
): T[] {
  const played = new Set(recent);
  const fresh = pool.filter((song) => genreOf(song) === genre && !played.has(song.key));
  return sampleCrate(fresh, [], SET_MAX, rng);
}

/** A block needs this many unplayed kitchen songs of its genre to start: two sets' worth. */
export const BLOCK_MIN_FRESH = 6;

/**
 * The profile without genres too thin for a block: fewer than `min` kitchen
 * songs that have not played recently. One metal song is not a metal block.
 */
export function blockProfile<T extends FmSong>(
  profile: ReadonlyMap<GenreId, number>,
  pool: readonly T[],
  recent: readonly string[],
  genreOf: (song: T) => GenreId | undefined,
  min = BLOCK_MIN_FRESH,
): Map<GenreId, number> {
  const played = new Set(recent);
  const fresh = new Map<GenreId, number>();
  for (const song of pool) {
    const genre = genreOf(song);
    if (!genre || played.has(song.key) || !songFits(song.durationSec)) continue;
    fresh.set(genre, (fresh.get(genre) ?? 0) + 1);
  }
  return new Map([...profile].filter(([genre]) => (fresh.get(genre) ?? 0) >= min));
}

/**
 * How many new finds this set may hold. More when the kitchen has fewer than
 * five fresh songs, so the set can still fill. Never more than 3.
 */
export function findAllowance(discover: number, freshKitchen: number): number {
  const base = Math.min(3, Math.max(0, Math.round(Number.isFinite(discover) ? discover : 0)));
  if (freshKitchen >= SET_MAX) return base;
  return Math.min(3, Math.max(base, SET_MAX - Math.max(0, freshKitchen)));
}

/** How many kitchen songs to keep so the finds still fit in a set of five. */
export function kitchenSlots(songCount: number, finds: number): number {
  const room = SET_MAX - Math.max(0, finds);
  return Math.min(Math.max(0, songCount), Math.max(0, room));
}

/**
 * Deezer artist ids to look up related artists from, listeners' songs first.
 * Each artist appears once.
 */
export function seedArtistIds(
  songs: readonly { from: { userId?: string }; deezerArtistId?: number }[],
  listenerIds: ReadonlySet<string>,
  rng: () => number = Math.random,
): number[] {
  const listeners: number[] = [];
  const rest: number[] = [];
  const seen = new Set<number>();
  for (const song of songs) {
    const id = song.deezerArtistId;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (song.from.userId && listenerIds.has(song.from.userId)) listeners.push(id);
    else rest.push(id);
  }
  return [...shuffle(listeners, rng), ...shuffle(rest, rng)];
}

/**
 * One top track the kitchen has not played, at most `MAX_SONG_SEC` long.
 * Looks at the first few acceptable tops so a set is not always the biggest hit.
 */
export function pickDiscoverTrack<T extends { artist: string; title: string; durationSec: number }>(
  tops: readonly T[],
  blocked: readonly { artist: string; title: string }[],
  rng: () => number = Math.random,
): T | null {
  const choices = tops.filter((track) => {
    if (track.durationSec <= 0 || !songFits(track.durationSec)) return false;
    return !blocked.some((song) =>
      isSameSong(
        { artist: track.artist, title: track.title },
        {
          title: song.artist ? `${song.artist} - ${song.title}` : song.title,
          uploader: song.artist,
        },
      ),
    );
  });
  if (choices.length === 0) return null;
  const pool = choices.slice(0, 5);
  return pool[Math.floor(rng() * pool.length)] ?? null;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
