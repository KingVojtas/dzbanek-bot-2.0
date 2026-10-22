import type { Track } from '../core/types';
import { catchKeys } from '../radio/now-playing';

/** A song a quiz round can play. Catches carry only a search query until their round. */
export interface QuizSong {
  /** Normalized artist + title: two rows with the same key are the same song. */
  key: string;
  artist: string;
  title: string;
  /** Button text, at most 80 characters. */
  label: string;
  /** YouTube page. Missing for a radio catch until it is looked up. */
  url?: string;
  /** What to search YouTube for when `url` is missing. */
  query: string;
  durationSec: number;
  thumbnail?: string;
  /** Who put it in the pool: a /play, a 🍪 catch, or a playlist. */
  from: { kind: 'play' | 'catch' | 'playlist'; userId?: string };
}

/** Rounds, points, and timing. */
export const QUIZ_CLIP_SEC = 15;
export const QUIZ_ANSWER_MS = 20_000;
export const QUIZ_CHOICES = 4;

const NOISE =
  /\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(ed)?|music\s*video|mv|clip|explicit|color\s*coded|full\s*album|videoclip|oficiální)\b/i;

/** "Artist - Song (Official Video) [4K] | Label" → "Artist - Song". */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/[([【][^)\]】]*[)\]】]/g, (part) => (NOISE.test(part) ? ' ' : part))
    .replace(/\s+[|/]\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '')
    .trim();
}

function cleanArtist(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*(official|music|records)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortLabel(artist: string, title: string): string {
  const label =
    artist && artist.toLowerCase() !== title.toLowerCase() ? `${artist} — ${title}` : title;
  return label.length <= 80 ? label : `${label.slice(0, 79).trimEnd()}…`;
}

function makeSong(
  artist: string,
  title: string,
  rest: Omit<QuizSong, 'key' | 'artist' | 'title' | 'label' | 'query'>,
): QuizSong {
  const keys = catchKeys(artist, title);
  return {
    key: `${keys.artistKey}|${keys.titleKey}`,
    artist,
    title,
    label: shortLabel(artist, title),
    query: artist ? `${artist} - ${title}` : title,
    ...rest,
  };
}

/** A played or playlist track. "Artist - Song" titles split; otherwise the channel is the artist. */
export function songFromTrack(
  track: Pick<Track, 'title' | 'url' | 'uploader' | 'durationSec' | 'thumbnail'>,
  from: QuizSong['from'],
): QuizSong {
  const clean = cleanTitle(track.title) || track.title.trim();
  const split = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const artist = split ? split[1]!.trim() : cleanArtist(track.uploader);
  const title = split ? split[2]!.trim() : clean;
  return makeSong(artist, title, {
    url: track.url,
    durationSec: track.durationSec,
    thumbnail: track.thumbnail,
    from,
  });
}

/** A radio catch: artist and title are already clean. */
export function songFromCatch(row: { artist: string; title: string; userId: string }): QuizSong {
  return makeSong(row.artist.trim(), row.title.trim(), {
    durationSec: 0,
    from: { kind: 'catch', userId: row.userId },
  });
}

/** First of each song wins; a title nobody could read is dropped. */
export function dedupeSongs(songs: QuizSong[]): QuizSong[] {
  const seen = new Set<string>();
  const labels = new Set<string>();
  return songs.filter((song) => {
    const label = song.label.toLowerCase();
    if (!song.title || seen.has(song.key) || labels.has(label)) return false;
    seen.add(song.key);
    labels.add(label);
    return true;
  });
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * The four buttons: the answer and three other songs from the pool, other
 * artists first so the answer cannot be spotted by its name alone.
 */
export function buildChoices(
  pool: QuizSong[],
  answer: QuizSong,
  rng: () => number = Math.random,
): { labels: string[]; correct: number } {
  const artist = answer.artist.toLowerCase();
  const others = shuffle(
    pool.filter((song) => song.key !== answer.key && song.label !== answer.label),
    rng,
  ).sort(
    (a, b) => Number(a.artist.toLowerCase() === artist) - Number(b.artist.toLowerCase() === artist),
  );
  const decoys: QuizSong[] = [];
  for (const song of others) {
    if (decoys.length === QUIZ_CHOICES - 1) break;
    if (decoys.some((decoy) => decoy.label === song.label)) continue;
    decoys.push(song);
  }
  const labels = shuffle([answer, ...decoys], rng).map((song) => song.label);
  return { labels, correct: labels.indexOf(answer.label) };
}

/**
 * 100 for the right song, up to 50 more for speed (falling to 0 over the
 * answer window), and 25 on every third right answer in a row.
 */
export function roundPoints(elapsedMs: number, streak: number, windowMs = QUIZ_ANSWER_MS): number {
  const speed = Math.round(50 * Math.max(0, Math.min(1, 1 - elapsedMs / windowMs)));
  const bonus = streak > 0 && streak % 3 === 0 ? 25 : 0;
  return 100 + speed + bonus;
}

/** Where the clip starts: 35 % in, past the intro, and never past the end. */
export function clipStart(durationSec: number): number {
  if (!durationSec || durationSec <= 0) return 45;
  const start = Math.min(90, Math.max(20, Math.round(durationSec * 0.35)));
  return Math.max(0, Math.min(start, Math.floor(durationSec - QUIZ_CLIP_SEC - 1)));
}
