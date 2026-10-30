import { joinClips, silenceMs } from './dedications';
import { fillBreak, type BreakBook, type BreakSlots } from './breaks';
import { mixBed, mixBedAsync, type MixRange } from './jingles';
import { pcmSeconds } from '../music/intro-wait';
import { breakGap, stationChime } from './stinger';

/** Spoken parts of one break, plus a jingle file standing in for one of them. */
export type BreakRole =
  | 'chime'
  | 'id'
  | 'idFile'
  | 'recap'
  | 'promo'
  | 'sweeper'
  | 'comingUp'
  | 'back'
  | 'genre'
  | 'outro';

/** How long the coming-up and the outro are assumed to take, before they exist. */
export const BREAK_TAIL_SEC = 20;
/**
 * The chime and the spoken outro, inside {@link BREAK_TAIL_SEC}.
 * A genre jingle replaces that part, so the reserve drops it.
 */
export const BREAK_OUTRO_SEC = 8;
/** Edge budget for one break line. A promo is longer than a set line. */
export const BREAK_SPEAK_MS = 60_000;
/** Quiet between break parts. */
export const BREAK_GAP_MS = 500;

/** One voice. A throw or a null clip means that part is left out. */
export type BreakSpeak = (text: string, budgetMs: number) => Promise<Buffer | null>;

/** The two voices of a break. The jingle voice never shares the DJ's miss counter. */
export interface BreakVoices {
  jingle: BreakSpeak;
  dj: BreakSpeak;
}

/**
 * Jingle files for one break. Each call returns PCM, or null when that file
 * is missing or will not decode. `id` and `sweeper` move on to the next file.
 */
export interface BreakFiles {
  id: () => Promise<Buffer | null>;
  sweeper: () => Promise<Buffer | null>;
  back: () => Promise<Buffer | null>;
  genre: () => Promise<Buffer | null>;
}

/** Indexes already said this show. A break will not repeat one of them inside itself. */
export interface BreakUsed {
  ids: Set<number>;
  promos: Set<number>;
}

/** What a render produced. `roles` is the order that actually got audio. */
export interface BreakClip {
  pcm: Buffer | null;
  /** True when a voice or a jingle file is in `pcm`. Chimes alone do not count. */
  voiced: boolean;
  seconds: number;
  roles: BreakRole[];
  /** Where the bed is heard. Empty when there is nothing to play. */
  ranges: MixRange[];
}

/** An empty clip, for a voice that failed or a break that was not made. */
export function emptyBreak(): BreakClip {
  return { pcm: null, voiced: false, seconds: 0, roles: [], ranges: [] };
}

/**
 * Seconds to leave for the tail. `backSec` and `genreSec` are the real files.
 * A genre file replaces the chime and the spoken outro, so that allowance is
 * dropped. With no files this is `allowance`, which is {@link BREAK_TAIL_SEC}.
 */
export function breakTailReserve(backSec = 0, genreSec = 0, allowance = BREAK_TAIL_SEC): number {
  const back = Number.isFinite(backSec) ? Math.max(0, backSec) : 0;
  const genre = Number.isFinite(genreSec) ? Math.max(0, genreSec) : 0;
  if (genre > 0) return Math.max(0, allowance - BREAK_OUTRO_SEC) + back + genre;
  return allowance + back;
}

/**
 * Steps 1–3: a station ID, the recap, then promo, sweeper, promo and an ID
 * until the running length reaches `targetSec` minus the tail estimate.
 * A file stands in for the chime and the spoken ID, and for the sweeper,
 * when `files` has one. A missing file is the spoken piece from before.
 * A promo or a spoken ID is not repeated inside this break. Nothing is
 * padded with silence to hit the target.
 */
export async function renderBreakHead(
  book: BreakBook,
  slots: Pick<BreakSlots, 'server' | 'lastGenre' | 'artists'>,
  voices: BreakVoices,
  used: BreakUsed,
  targetSec: number,
  rng: () => number = Math.random,
  tailSec = BREAK_TAIL_SEC,
  files: BreakFiles | null = null,
): Promise<BreakClip> {
  if (targetSec <= 0) return emptyBreak();
  const built = createAssembly();
  const stopAt = Math.max(0, targetSec - tailSec);
  const seen = { ids: new Set<number>(), promos: new Set<number>() };

  const filled: BreakSlots = { ...slots, genre: '', songs: '', count: '' };
  const opening = files ? await files.id() : null;
  if (opening?.length) built.file('idFile', opening);
  else {
    built.chime();
    await built.voice(
      'id',
      voices.jingle,
      take(book.ids, used.ids, seen.ids, rng),
      book.ids,
      filled,
    );
  }
  await built.voice(
    'recap',
    voices.dj,
    take(book.recap, new Set(), new Set(), rng),
    book.recap,
    filled,
  );

  while (built.seconds < stopAt) {
    const before = built.seconds;
    let spoke = false;
    for (let n = 0; n < 2 && built.seconds < stopAt; n += 1) {
      const index = take(book.promos, used.promos, seen.promos, rng);
      if (index < 0) break;
      if (await built.voice('promo', voices.jingle, index, book.promos, filled)) spoke = true;
      if (n === 0 && built.seconds < stopAt) {
        const sweeper = files ? await files.sweeper() : null;
        if (sweeper?.length) {
          built.file('sweeper', sweeper);
          spoke = true;
        }
      }
    }
    if (built.seconds >= stopAt) break;
    const idFile = files ? await files.id() : null;
    if (idFile?.length) {
      built.file('idFile', idFile);
      spoke = true;
    } else {
      const id = take(book.ids, used.ids, seen.ids, rng);
      if (id < 0) {
        if (!spoke) break;
        continue;
      }
      built.chime();
      if (await built.voice('id', voices.jingle, id, book.ids, filled)) spoke = true;
    }
    if (!spoke || built.seconds === before) break;
  }
  return built.finish();
}

/**
 * Steps 4–5: the DJ names the next songs, then back-to-music and the genre
 * jingle. The genre file replaces the chime and the spoken outro. Without
 * it, that chime and outro play as before. Either voice failing leaves
 * that part out.
 */
export async function renderBreakTail(
  book: BreakBook,
  slots: Pick<BreakSlots, 'genre' | 'songs' | 'count'>,
  voices: BreakVoices,
  rng: () => number = Math.random,
  files: BreakFiles | null = null,
): Promise<BreakClip> {
  const built = createAssembly();
  const full: BreakSlots = {
    server: '',
    lastGenre: '',
    artists: '',
    genre: slots.genre,
    songs: slots.songs,
    count: slots.count,
  };
  await built.voice(
    'comingUp',
    voices.dj,
    take(book.comingUp, new Set(), new Set(), rng),
    book.comingUp,
    full,
  );
  const back = files ? await files.back() : null;
  if (back?.length) built.file('back', back);
  const genre = files ? await files.genre() : null;
  if (genre?.length) built.file('genre', genre);
  else {
    built.chime();
    await built.voice(
      'outro',
      voices.jingle,
      take(book.outro, new Set(), new Set(), rng),
      book.outro,
      full,
    );
  }
  return built.finish();
}

/** Head, a gap, then the tail. No voice in either half means there is no break. */
export function joinBreak(head: BreakClip, tail: BreakClip): BreakClip {
  const voiced = head.voiced || tail.voiced;
  const roles = [...head.roles, ...tail.roles];
  if (!voiced) return { pcm: null, voiced: false, seconds: 0, roles, ranges: [] };
  const headPcm = head.pcm?.length ? head.pcm : null;
  const tailPcm = tail.pcm?.length ? tail.pcm : null;
  const pcm = joinClips([headPcm, tailPcm], BREAK_GAP_MS);
  let ranges: MixRange[];
  if (headPcm && tailPcm) {
    const gapLen = silenceMs(BREAK_GAP_MS).length;
    const shift = headPcm.length + gapLen;
    ranges = [
      ...head.ranges,
      {
        startByte: headPcm.length,
        endByte: headPcm.length + gapLen,
        spoken: edgeSpoken(head.ranges, 'end') || edgeSpoken(tail.ranges, 'start'),
      },
      ...tail.ranges.map((range) => ({
        ...range,
        startByte: range.startByte + shift,
        endByte: range.endByte + shift,
      })),
    ];
  } else if (headPcm) {
    ranges = head.ranges;
  } else {
    ranges = tail.ranges;
  }
  return { pcm, voiced: true, seconds: pcm ? pcmSeconds(pcm) : 0, roles, ranges };
}

/** The bed under `clip`, or `clip` itself when there is nothing to mix. */
export function applyBed(clip: BreakClip, bed: Buffer | null | undefined): BreakClip {
  if (!clip.pcm?.length || !bed?.length) return clip;
  const pcm = mixBed(clip.pcm, clip.ranges, bed);
  return { ...clip, pcm, seconds: pcmSeconds(pcm) };
}

/** `applyBed` in chunks, so the songs on air do not stutter while a long break is mixed. */
export async function applyBedAsync(
  clip: BreakClip,
  bed: Buffer | null | undefined,
): Promise<BreakClip> {
  if (!clip.pcm?.length || !bed?.length) return clip;
  const pcm = await mixBedAsync(clip.pcm, clip.ranges, bed);
  return { ...clip, pcm, seconds: pcmSeconds(pcm) };
}

/**
 * One unused line. Prefer lines this show has not said. Never one this break
 * has already said. -1 when every line was used in this break.
 */
export function takeBreakLine(
  lines: readonly string[],
  showUsed: Set<number>,
  breakUsed: Set<number>,
  rng: () => number,
): number {
  const fresh: number[] = [];
  const later: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (breakUsed.has(index)) continue;
    if (showUsed.has(index)) later.push(index);
    else fresh.push(index);
  }
  const pool = fresh.length > 0 ? fresh : later;
  if (pool.length === 0) return -1;
  const index = pool[Math.floor(rng() * pool.length)] ?? -1;
  if (index < 0) return -1;
  showUsed.add(index);
  breakUsed.add(index);
  return index;
}

function take(
  lines: readonly string[],
  showUsed: Set<number>,
  breakUsed: Set<number>,
  rng: () => number,
): number {
  return takeBreakLine(lines, showUsed, breakUsed, rng);
}

function edgeSpoken(ranges: readonly MixRange[], side: 'start' | 'end'): boolean {
  if (ranges.length === 0) return false;
  const range = side === 'start' ? ranges[0] : ranges[ranges.length - 1];
  return Boolean(range?.spoken);
}

interface Span {
  pcm: Buffer;
  role: BreakRole;
  spoken: boolean;
}

interface Assembly {
  seconds: number;
  chime(): void;
  /** A jingle file. It counts as the break having something to play. */
  file(role: BreakRole, pcm: Buffer): void;
  voice(
    role: BreakRole,
    speak: BreakSpeak,
    index: number,
    lines: readonly string[],
    slots: BreakSlots,
  ): Promise<boolean>;
  finish(): BreakClip;
}

function createAssembly(): Assembly {
  const spans: Span[] = [];
  const roles: BreakRole[] = [];
  let voiced = false;
  let filed = false;
  let seconds = 0;
  const gap = breakGap();
  const chimePcm = stationChime();

  const push = (pcm: Buffer, role: BreakRole, spoken: boolean): void => {
    if (spans.length > 0) seconds += pcmSeconds(gap);
    spans.push({ pcm, role, spoken });
    roles.push(role);
    seconds += pcmSeconds(pcm);
  };

  return {
    get seconds() {
      return seconds;
    },
    chime() {
      push(chimePcm, 'chime', false);
    },
    file(role, pcm) {
      push(pcm, role, false);
      filed = true;
    },
    async voice(role, speak, index, lines, slots) {
      const template = lines[index];
      if (index < 0 || !template) return false;
      let pcm: Buffer | null;
      try {
        pcm = await speak(fillBreak(template, slots), BREAK_SPEAK_MS);
      } catch {
        pcm = null;
      }
      if (!pcm?.length) return false;
      push(pcm, role, true);
      voiced = true;
      return true;
    },
    finish() {
      if (!voiced && !filed) return { pcm: null, voiced: false, seconds: 0, roles, ranges: [] };
      const pieces: Buffer[] = [];
      const ranges: MixRange[] = [];
      let offset = 0;
      for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i];
        if (!span) continue;
        if (i > 0) {
          const previous = spans[i - 1];
          pieces.push(gap);
          ranges.push({
            startByte: offset,
            endByte: offset + gap.length,
            spoken: Boolean(previous?.spoken || span.spoken),
          });
          offset += gap.length;
        }
        pieces.push(span.pcm);
        ranges.push({
          startByte: offset,
          endByte: offset + span.pcm.length,
          spoken: span.spoken,
        });
        offset += span.pcm.length;
      }
      const pcm = pieces.length > 0 ? Buffer.concat(pieces) : null;
      return { pcm, voiced: true, seconds: pcm ? pcmSeconds(pcm) : 0, roles, ranges };
    },
  };
}
