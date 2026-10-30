import type { Track } from '../core/types';
import { JINGLE_GAP_MS } from './jingles';
import { fillLine, type LineSlots } from './lines';
import type { DjLanguage } from './script';

/** One dedication per person, and this many waiting in one server. */
export const DEDICATION_LIMIT = 3;
/** Quiet between a dedication and the set line that follows it. */
export const DEDICATION_GAP_MS = 300;
/** s16le, 48 kHz, stereo: one frame is 4 bytes. */
const PCM_FRAME = 4;
const PCM_RATE = 48_000;

const USER_MENTION = /<@!?(\d+)>/g;
const ROLE_MENTION = /<@&\d+>/g;
const CHANNEL_MENTION = /<#\d+>/g;
const CUSTOM_EMOJI = /<a?:[a-zA-Z0-9_]+:\d+>/g;
const URL = /(?:https?:\/\/|www\.)\S+/gi;

/** A YouTube playlist link, not a single video that happens to sit in a list. */
export function isYouTubePlaylistLink(input: string): boolean {
  if (!/youtu\.?be|youtube\.com/i.test(input)) return false;
  if (/youtu\.be\/[A-Za-z0-9_-]{6,}/i.test(input)) return false;
  return /[?&]list=|\/playlist\?/i.test(input) && !/[?&]v=/i.test(input);
}

/**
 * Words the DJ can say. Mentions of people become display names. Role and
 * channel mentions, custom emoji, and URLs are dropped. Empty means it said nothing.
 */
export function cleanDedication(raw: string, names: ReadonlyMap<string, string>): string {
  return raw
    .replace(USER_MENTION, (_whole, id: string) => {
      const name = names.get(id)?.trim();
      return name || ' ';
    })
    .replace(ROLE_MENTION, ' ')
    .replace(CHANNEL_MENTION, ' ')
    .replace(CUSTOM_EMOJI, ' ')
    .replace(URL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
}

/** The public reply once a dedication is in. `song` is already the spoken name. */
export function dedicationReply(from: string, to: string, song: string): string {
  const target = to ? ` for ${to}` : '';
  const when = song ? `before ${song}` : 'before the next song';
  return `💌 ${from}'s dedication${target} is in. The DJ reads it ${when}.`;
}

/** Silence of `ms`, as s16le 48 kHz stereo PCM. */
export function silenceMs(ms: number): Buffer {
  const frames = Math.round((PCM_RATE * ms) / 1000);
  return Buffer.alloc(frames * PCM_FRAME);
}

/**
 * Clips in order, with `gapMs` of silence between the ones that have audio.
 * Null when every part is missing.
 */
export function joinClips(
  parts: readonly (Buffer | null | undefined)[],
  gapMs = DEDICATION_GAP_MS,
): Buffer | null {
  const clips = parts.filter((part): part is Buffer => Boolean(part?.length));
  if (clips.length === 0) return null;
  if (clips.length === 1) return clips[0] ?? null;
  const gap = silenceMs(gapMs);
  const joined: Buffer[] = [];
  clips.forEach((clip, index) => {
    if (index > 0) joined.push(gap);
    joined.push(clip);
  });
  return Buffer.concat(joined);
}

/**
 * The dedication jingle, the spoken dedication, then the set line.
 * The jingle sits half a second ahead of the dedication. The dedication
 * and the set line keep the shorter gap. Either side may be missing.
 * Null when there is nothing to play.
 */
export function joinIntro(
  dedication: Buffer | null,
  setLine: Buffer | null,
  jingle?: Buffer | null,
): Buffer | null {
  const spoken = jingle?.length ? joinClips([jingle, dedication], JINGLE_GAP_MS) : dedication;
  return joinClips([spoken, setLine], DEDICATION_GAP_MS);
}

const FALLBACK: Record<DjLanguage, Record<'both' | 'to' | 'song' | 'plain', string>> = {
  en: {
    both: 'A message from {from} for {to}: "{message}". Here\'s {song}.',
    to: 'A message from {from} for {to}: "{message}".',
    song: '{from} sends this: "{message}". Here\'s {song}.',
    plain: '{from} sends this: "{message}".',
  },
  // Names can't be declined, so the Czech lines keep them in the nominative: "Od: Vojta, pro: Štěpán".
  cs: {
    both: 'Máme tu vzkaz. Od: {from}, pro: {to}. „{message}“ A k tomu hraje {song}.',
    to: 'Máme tu vzkaz. Od: {from}, pro: {to}. „{message}“',
    song: 'Píše {from}: „{message}“ A k tomu hraje {song}.',
    plain: 'Píše {from}: „{message}“',
  },
};

export interface DedicationSlots {
  from: string;
  to: string;
  message: string;
  song: string;
}

/** A line whose `{to}` and `{song}` match whether this dedication has them. */
export function dedicationCandidates(
  lines: readonly string[],
  hasTo: boolean,
  hasSong: boolean,
): string[] {
  return lines.filter((line) => {
    const usesTo = line.includes('{to}');
    const usesSong = line.includes('{song}');
    return usesTo === hasTo && usesSong === hasSong;
  });
}

/** The sentence the DJ reads. Names stay as they were written. */
export function dedicationText(
  lines: readonly string[],
  slots: DedicationSlots,
  language: DjLanguage,
  rng: () => number = Math.random,
): string {
  const hasTo = slots.to.trim().length > 0;
  const hasSong = slots.song.trim().length > 0;
  const fitting = dedicationCandidates(lines, hasTo, hasSong);
  const shape = hasTo && hasSong ? 'both' : hasTo ? 'to' : hasSong ? 'song' : 'plain';
  const pool = fitting.length > 0 ? fitting : [FALLBACK[language][shape]];
  const line = pool[Math.floor(rng() * pool.length)] ?? FALLBACK[language][shape];
  const filled: LineSlots = {
    server: '',
    time: '',
    daypart: '',
    genre: '',
    artist: '',
    by: '',
    names: '',
    station: 'Kitchen FM',
    from: slots.from,
    to: slots.to,
    message: slots.message,
    song: slots.song,
  };
  return fillLine(line, filled);
}

/** A dedication waiting for its song. `track` null means the next song that starts. */
export interface WaitingDedication {
  userId: string;
  from: string;
  to: string;
  message: string;
  track: Track | null;
  song: string;
  text: string;
  speech: Promise<Buffer | null>;
}

/** The dedications one show has not read yet. Dropped when the show ends. */
export class DedicationQueue {
  private waiting: WaitingDedication[] = [];

  get length(): number {
    return this.waiting.length;
  }

  /** Why another one cannot join. Null when it can. */
  block(userId: string): 'yours' | 'full' | null {
    if (this.waiting.some((item) => item.userId === userId)) return 'yours';
    if (this.waiting.length >= DEDICATION_LIMIT) return 'full';
    return null;
  }

  add(dedication: WaitingDedication): void {
    this.waiting.push(dedication);
  }

  /**
   * The dedication this song should read. One bound to `track` wins.
   * Otherwise the oldest that is waiting for whatever comes next.
   */
  take(track: Track): WaitingDedication | null {
    const bound = this.waiting.findIndex((item) => item.track === track);
    const index = bound >= 0 ? bound : this.waiting.findIndex((item) => item.track === null);
    if (index < 0) return null;
    return this.waiting.splice(index, 1)[0] ?? null;
  }

  /** Back at the front, read before the next song (`track` should be null). */
  returnFront(dedication: WaitingDedication): void {
    this.waiting.unshift(dedication);
  }

  clear(): void {
    this.waiting = [];
  }
}
