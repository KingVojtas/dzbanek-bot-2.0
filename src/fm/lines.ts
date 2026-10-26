import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLine } from './script';
import type { DjLanguage } from './script';

/** When the DJ says a line, and the blanks that line has to carry. */
export const LINE_MOMENTS = {
  showOpen: { min: 40, words: 20, needs: ['server', 'genre', 'song'] },
  blockOpen: { min: 40, words: 40, needs: ['genre', 'song'] },
  setOpen: { min: 40, words: 25, needs: ['song'] },
  welcome: { min: 15, words: 40, needs: ['names'] },
  byPlay: { min: 15, words: 40, needs: ['by'] },
  byCatch: { min: 15, words: 40, needs: ['by'] },
  newFind: { min: 15, words: 40, needs: [] },
  lateNight: { min: 40, words: 40, needs: ['genre', 'song'] },
} as const;

export type Moment = keyof typeof LINE_MOMENTS;

/** Blanks a line is allowed to use. */
export const LINE_BLANKS = [
  'server',
  'time',
  'daypart',
  'genre',
  'song',
  'artist',
  'by',
  'names',
  'station',
] as const;

export type LineBlank = (typeof LINE_BLANKS)[number];

export interface LineFile {
  version: 1;
  lines: Record<Moment, string[]>;
}

/** The values that fill a line. `song`, `time`, and `daypart` are already phrased. */
export interface LineSlots {
  server: string;
  time: string;
  daypart: string;
  genre: string;
  song: string;
  artist: string;
  by: string;
  names: string;
  station: string;
}

const BLANK = /\{([a-z]+)\}/g;

/** "Numb by Linkin Park", or "Numb – Linkin Park" in Czech. */
export function songPhrase(artist: string, title: string, language: DjLanguage): string {
  if (!artist) return title;
  return language === 'cs' ? `${title} – ${artist}` : `${title} by ${artist}`;
}

/** "6 PM" or "6:04 PM" in English. "18:04" in Czech. */
export function lineTime(hour: number, minute: number, language: DjLanguage): string {
  if (language === 'cs') return `${hour}:${String(minute).padStart(2, '0')}`;
  const h = hour % 12 || 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const m = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${h}${m} ${suffix}`;
}

/** A spoken part of the day. Czech stays a noun, so it does not have to agree with "dobrý". */
export function lineDaypart(hour: number, language: DjLanguage): string {
  if (language === 'cs') {
    if (hour < 5) return 'noc';
    if (hour < 12) return 'ráno';
    if (hour < 18) return 'odpoledne';
    return 'večer';
  }
  if (hour < 5) return 'late night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/** "Ana and Ben", or "Ana a Ben". Names stay in the nominative. */
export function joinNames(names: readonly string[], language: DjLanguage): string {
  const and = language === 'cs' ? 'a' : 'and';
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

/** Which lines make one spoken turn, in the order the DJ says them. */
export function momentsFor(facts: {
  set: number;
  newBlock: boolean;
  hour: number;
  newcomers: readonly string[];
  how: 'play' | 'catch' | 'new';
  by: string | null;
}): Moment[] {
  const main: Moment =
    facts.set <= 1
      ? 'showOpen'
      : facts.newBlock
        ? facts.hour < 5
          ? 'lateNight'
          : 'blockOpen'
        : 'setOpen';
  const moments: Moment[] = [];
  if (facts.set > 1 && facts.newcomers.length > 0) moments.push('welcome');
  moments.push(main);
  if (facts.how === 'new') moments.push('newFind');
  else if (facts.by && facts.how === 'catch') moments.push('byCatch');
  else if (facts.by) moments.push('byPlay');
  return moments;
}

/** Replace blanks. An unknown blank is left as written so a bad line is obvious. */
export function fillLine(template: string, slots: LineSlots): string {
  return template.replace(BLANK, (whole, name: string) => {
    const value = slots[name as LineBlank];
    return value ?? whole;
  });
}

/** Words, for the line-book limit. A blank counts as one. */
export function wordCount(line: string): number {
  return line.split(/\s+/).filter(Boolean).length;
}

/** Blanks a template actually uses. */
export function blanksIn(line: string): string[] {
  return [...line.matchAll(BLANK)].map((match) => match[1]!);
}

/**
 * An unused line for this moment, then marked used. When every line has been
 * said this show, the book starts over.
 */
export function takeLine(lines: readonly string[], used: Set<number>, rng: () => number): number {
  if (lines.length === 0) return -1;
  const free = lines.flatMap((_, index) => (used.has(index) ? [] : [index]));
  if (free.length === 0) used.clear();
  const pool = free.length > 0 ? free : lines.map((_, index) => index);
  const index = pool[Math.floor(rng() * pool.length)] ?? 0;
  used.add(index);
  return index;
}

/** The line book for one language: pick a line, fill it, don't repeat it this show. */
export class LineBook {
  constructor(private readonly file: LineFile) {}

  /** The raw lines of one moment. */
  of(moment: Moment): readonly string[] {
    return this.file.lines[moment] ?? [];
  }

  /**
   * One turn: a welcome, the set line, then who brought the song.
   * Null when the main moment has no lines, so the caller can fall back.
   */
  speak(
    moments: readonly Moment[],
    slots: LineSlots,
    used: Map<Moment, Set<number>>,
    rng: () => number = Math.random,
  ): string | null {
    const main = moments.find(
      (moment) =>
        moment === 'showOpen' ||
        moment === 'blockOpen' ||
        moment === 'setOpen' ||
        moment === 'lateNight',
    );
    if (!main || this.of(main).length === 0) return null;
    const parts: string[] = [];
    for (const moment of moments) {
      const lines = this.of(moment);
      if (lines.length === 0) continue;
      const bucket = used.get(moment) ?? new Set<number>();
      used.set(moment, bucket);
      const index = takeLine(lines, bucket, rng);
      if (index < 0) continue;
      parts.push(fillLine(lines[index]!, slots));
    }
    const text = cleanLine(parts.join(' '));
    return text || null;
  }
}

/** Load `src/fm/lines/<language>.json`. Null when the file is missing or broken. */
export function loadLineBook(language: DjLanguage): LineBook | null {
  try {
    return new LineBook(readLineFile(language));
  } catch {
    return null;
  }
}

/** The book on disk. Throws when the file is not the expected shape. */
export function readLineFile(language: DjLanguage): LineFile {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'lines', `${language}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LineFile>;
  if (raw.version !== 1 || !raw.lines)
    throw new Error(`Kitchen FM line book ${language} is unreadable.`);
  return { version: 1, lines: raw.lines };
}
