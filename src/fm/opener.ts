import type { Track } from '../core/types';
import type { GenreId } from './genres';
import { blanksIn, fillLine, songPhrase, type LineSlots } from './lines';
import { cleanLine, prepareBlocked, sidelined, type DjLanguage, type OpenerSong } from './script';

/** A prepared opener older than this is dropped. YouTube links go bad. */
export const OPENER_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * The first song of the next show, found and voiced ahead of time.
 * Held in memory only. Preparing it is not airing it.
 */
export interface PreparedOpener {
  track: Track;
  artist: string;
  title: string;
  how: 'play' | 'catch' | 'new';
  by: string | null;
  /** Pool key, so a later play of the same song can be spotted. */
  key: string;
  /** Rotation genre this song opens. */
  genre: GenreId;
  /**
   * The cursor genre this opener was prepared after. Null when the server
   * had not ended a show yet. A later show moves the cursor, and this opener
   * is dropped.
   */
  after: GenreId | null;
  line: string;
  /** PCM of `line`. Null when the voice failed; the show synthesizes it then. */
  pcm: Buffer | null;
  /**
   * The song's whole audio as the source streams it, so the show does not wait
   * for YouTube. Missing when the download failed or the song is too big.
   */
  audio?: Buffer | null;
  preparedAt: number;
  language: DjLanguage;
  voice: string;
}

/**
 * Read `stream` to its end. Null when it holds more than `maxBytes`, takes
 * longer than `timeoutMs`, or fails; the stream is destroyed then.
 */
export function readWhole(
  stream: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (value === null) stream.destroy?.();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > maxBytes) {
        finish(null);
        return;
      }
      chunks.push(bytes);
    });
    stream.once('end', () => finish(size > 0 ? Buffer.concat(chunks) : null));
    stream.once('error', () => finish(null));
  });
}

/** What the show knows when it decides whether a prepared opener is still good. */
export interface OpenerCheck {
  now: number;
  language: DjLanguage;
  voice: string;
  airedKeys: ReadonlySet<string>;
  airedUrls: ReadonlySet<string>;
  plannedKeys: ReadonlySet<string>;
  plannedUrls: ReadonlySet<string>;
  /** The cursor genre the next show would follow. Null before the first show. */
  after: GenreId | null;
  blocked: boolean;
}

const CLOCK_BLANKS = new Set(['time', 'daypart']);

/**
 * Why `opener` cannot open the next show. Null when the show should use it.
 * The caller logs the reason and drops the opener.
 */
export function openerDropReason(opener: PreparedOpener, check: OpenerCheck): string | null {
  if (opener.after !== check.after) return 'the rotation moved on';
  if (check.now - opener.preparedAt >= OPENER_MAX_AGE_MS) return 'it is older than 12 hours';
  if (opener.language !== check.language) return 'it was made in another language';
  if (opener.voice !== check.voice) return 'the DJ voice changed';
  const aired =
    (opener.key !== '' && (check.airedKeys.has(opener.key) || check.plannedKeys.has(opener.key))) ||
    (opener.track.url !== '' &&
      (check.airedUrls.has(opener.track.url) || check.plannedUrls.has(opener.track.url)));
  if (aired) return 'it has aired since it was prepared';
  if (check.blocked) return 'it is blocked';
  return null;
}

/**
 * True when a 👎 should keep this song out. A kitchen song is sidelined from the
 * pool; a find is matched by name against the thumbs-down list.
 */
export function openerIsBlocked(
  opener: { key: string; artist: string; title: string },
  pool: readonly { key: string; heat?: number; nopes?: number }[],
  blocks: readonly { artist: string; title: string }[],
): boolean {
  const song = pool.find((item) => item.key === opener.key);
  if (song && sidelined(song)) return true;
  if (blocks.length === 0) return false;
  return prepareBlocked(blocks).matches({ artist: opener.artist, title: opener.title });
}

/** showOpen lines that do not name a clock time or a part of the day. */
export function timelessLines(lines: readonly string[]): string[] {
  return lines.filter((line) => blanksIn(line).every((blank) => !CLOCK_BLANKS.has(blank)));
}

/**
 * One showOpen line that will still be true hours later.
 * Null when every line names the time or the part of the day.
 */
export function preparedShowLine(
  lines: readonly string[],
  slots: LineSlots,
  rng: () => number = Math.random,
): string | null {
  const usable = timelessLines(lines);
  if (usable.length === 0) return null;
  const index = Math.min(usable.length - 1, Math.floor(rng() * usable.length));
  const text = cleanLine(fillLine(usable[index] ?? '', slots));
  return text || null;
}

/**
 * The built-in greeting when the line book has no timeless showOpen line.
 * No clock and no part of the day, so it can be said hours later.
 */
export function timelessOpener(facts: {
  language: DjLanguage;
  server: string;
  vibe: string;
  song: OpenerSong;
}): string {
  const song = songPhrase(facts.song.artist, facts.song.title, facts.language);
  if (facts.language === 'cs') {
    return `${facts.server}, tady Kitchen FM. Teď jdeme na: ${facts.vibe}. Začínáme: ${song}.`;
  }
  return `${facts.server}, this is Kitchen FM. We're going for ${facts.vibe}. First up, ${song}.`;
}
