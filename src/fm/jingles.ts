import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENRES, type GenreId } from './genres';
import { decodeClip } from './voice';

/** s16le, 48 kHz, stereo. One frame is two 16-bit channels. */
const RATE = 48_000;
const FRAME = 4;
/** Signed 16-bit full scale, short of the negative rail. */
const FULL_SCALE = 32_767;

/** Short jingles and sweepers are brought to this RMS. */
export const JINGLE_TARGET_DB = -20;
/** Nothing in a jingle is allowed to reach this. */
export const JINGLE_PEAK_DB = -1;
/** A bed under spoken parts, after it is normalized. */
export const BED_TARGET_DB = -34;
/** The bed fades out over this long beside a jingle, a sweeper, or a chime. */
export const BED_FADE_SEC = 0.4;
/** A looped bed overlaps itself by this long. */
export const BED_LOOP_FADE_SEC = 1;
/** Quiet between a jingle file and the line it introduces. */
export const JINGLE_GAP_MS = 500;
/** Decoded short jingles share a cache no bigger than this. */
export const JINGLE_CACHE_BYTES = 24 * 1024 * 1024;
/** The folder is listed again after this, so a new file needs no restart. */
export const JINGLE_RESCAN_MS = 60_000;
/**
 * Longest genre jingle the head plans for. The next genre is not chosen until
 * the tail, and the files in the folder run about 7 to 14 seconds.
 */
export const GENRE_JINGLE_RESERVE_SEC = 14;

const GENRE_IDS = new Set<string>(GENRES.map((genre) => genre.id));
const NAMED = new Set(['dedication', 'new-find', 'back-to-music']);

/** What a file in the jingle folder is for. */
export type JingleKind =
  'genre' | 'id' | 'sweeper' | 'bed' | 'dedication' | 'new-find' | 'back-to-music';

/** One audio file the folder scan accepted. */
export interface JingleFile {
  kind: JingleKind;
  /** Genre id, the part after `id-` / `sweeper-` / `bed-`, or the stem of a named file. */
  id: string;
  /** Absolute path, or the key a test decoder expects. */
  file: string;
}

/** Ids already played this show. A pick prefers one that is not in the set. */
export interface JingleUsed {
  ids: Set<string>;
  sweepers: Set<string>;
  beds: Set<string>;
}

/** One slice of an assembled break. `spoken` false is a jingle, a sweeper, or a chime. */
export interface MixRange {
  startByte: number;
  endByte: number;
  spoken: boolean;
}

/** A decoded-clip cache. Oldest entry is first. */
export interface PcmCache {
  bytes: Map<string, Buffer>;
  total: number;
}

/**
 * What `filename` is. Null for anything else, including a genre id the
 * rotation does not have. `.mp3` and `.wav` both count.
 */
export function classifyJingleName(filename: string): { kind: JingleKind; id: string } | null {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const match = /^(.*)\.(mp3|wav)$/i.exec(base);
  if (!match?.[1]) return null;
  const stem = match[1].toLowerCase();
  if (NAMED.has(stem)) return { kind: stem as JingleKind, id: stem };
  const genre = /^genre-([a-z0-9-]+)$/.exec(stem);
  if (genre?.[1]) {
    if (!GENRE_IDS.has(genre[1])) return null;
    return { kind: 'genre', id: genre[1] };
  }
  const prefixed = /^(id|sweeper|bed)-([a-z0-9-]+)$/.exec(stem);
  if (!prefixed?.[1] || !prefixed[2]) return null;
  return { kind: prefixed[1] as JingleKind, id: prefixed[2] };
}

/**
 * One file of `kind` this show has not used, or any of them when all of them
 * have been used. Null when the folder has none. The pick is marked used.
 */
export function pickJingle(
  files: readonly JingleFile[],
  kind: 'id' | 'sweeper' | 'bed',
  used: Set<string>,
  rng: () => number,
): JingleFile | null {
  const all = files.filter((file) => file.kind === kind);
  if (all.length === 0) return null;
  const fresh = all.filter((file) => !used.has(file.id));
  const pool = fresh.length > 0 ? fresh : all;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  const picked = pool[index];
  if (!picked) return null;
  used.add(picked.id);
  return picked;
}

/** `genre-<id>`, or null when that genre has no file. */
export function genreJingle(files: readonly JingleFile[], genre: GenreId): JingleFile | null {
  return files.find((file) => file.kind === 'genre' && file.id === genre) ?? null;
}

/** `dedication`, `new-find`, or `back-to-music`, or null. */
export function namedJingle(
  files: readonly JingleFile[],
  kind: 'dedication' | 'new-find' | 'back-to-music',
): JingleFile | null {
  return files.find((file) => file.kind === kind) ?? null;
}

/** `id-main`, or some other station ID when that file is not in the folder. */
export function mainIdJingle(
  files: readonly JingleFile[],
  rng: () => number = Math.random,
): JingleFile | null {
  const ids = files.filter((file) => file.kind === 'id');
  const main = ids.find((file) => file.id === 'main');
  if (main) return main;
  if (ids.length === 0) return null;
  const index = Math.min(ids.length - 1, Math.max(0, Math.floor(rng() * ids.length)));
  return ids[index] ?? null;
}

/**
 * A new-find jingle plays once in a rotation block, and not on the block's
 * first set: the break or the opener already played there.
 */
export function playNewFindJingle(facts: {
  how: string;
  opener: boolean;
  blockStart: boolean;
  played: boolean;
  rotation: boolean;
}): boolean {
  return (
    facts.rotation && facts.how === 'new' && !facts.opener && !facts.blockStart && !facts.played
  );
}

/**
 * The samples of `pcm` as 16-bit integers, without a copy when the buffer is
 * aligned. Typed arrays read in the machine's byte order, which is little-endian
 * on every machine this runs on, the same as s16le.
 */
function samplesOf(pcm: Buffer): Int16Array {
  const count = Math.floor(pcm.length / 2);
  if (pcm.byteOffset % 2 === 0) return new Int16Array(pcm.buffer, pcm.byteOffset, count);
  const copy = new Uint8Array(pcm.subarray(0, count * 2));
  return new Int16Array(copy.buffer, 0, count);
}

/** A fresh zeroed PCM buffer and its samples. `Buffer.alloc` is never pooled, so it is aligned. */
function blankPcm(samples: number): { buffer: Buffer; view: Int16Array } {
  const buffer = Buffer.alloc(samples * 2);
  return { buffer, view: new Int16Array(buffer.buffer, buffer.byteOffset, samples) };
}

/** The loudest sample, as a count. Silence is 0. */
export function pcmPeak(pcm: Buffer): number {
  const samples = samplesOf(pcm);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.abs(samples[i]!);
    if (sample > peak) peak = sample;
  }
  return peak;
}

/**
 * Samples, or frames, worked between two turns of the event loop: about two
 * seconds of audio. A whole 3-minute bed in one go blocks for a few hundred
 * milliseconds, and every server's song stutters while it does.
 */
const CHUNK_FRAMES = 2 * RATE;

/** Let the voice connections send their packets before the next chunk. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function eachChunk(total: number, size: number, step: (from: number, to: number) => void): void {
  for (let from = 0; from < total; from += size) step(from, Math.min(total, from + size));
}

async function eachChunkAsync(
  total: number,
  size: number,
  step: (from: number, to: number) => void,
): Promise<void> {
  for (let from = 0; from < total; from += size) {
    step(from, Math.min(total, from + size));
    await nextTurn();
  }
}

/** Sum of squares and the loudest sample so far. */
interface Level {
  sum: number;
  peak: number;
}

function measure(source: Int16Array, from: number, to: number, level: Level): void {
  let { sum, peak } = level;
  for (let i = from; i < to; i += 1) {
    const sample = source[i]!;
    sum += sample * sample;
    const size = sample < 0 ? -sample : sample;
    if (size > peak) peak = size;
  }
  level.sum = sum;
  level.peak = peak;
}

/** The gain that reaches `targetDb` RMS with the peak under `peakDb`. Null for silence. */
function fitGain(
  level: Level,
  count: number,
  targetDb: number,
  peakDb: number,
): { gain: number; cap: number } | null {
  if (count === 0 || level.sum === 0 || level.peak === 0) return null;
  const loud = 20 * Math.log10(Math.sqrt(level.sum / count) / 32_768);
  let gain = 10 ** ((targetDb - loud) / 20);
  const cap = Math.max(1, Math.floor(FULL_SCALE * 10 ** (peakDb / 20)));
  if (level.peak * gain > cap) gain = cap / level.peak;
  return { gain, cap };
}

function scale(
  source: Int16Array,
  view: Int16Array,
  fit: { gain: number; cap: number },
  from: number,
  to: number,
): void {
  const { gain, cap } = fit;
  for (let i = from; i < to; i += 1) {
    const scaled = Math.round(source[i]! * gain);
    view[i] = scaled > cap ? cap : scaled < -cap ? -cap : scaled;
  }
}

/**
 * Bring `pcm` to about `targetDb` RMS. The peak stays under `peakDb`.
 * Silence comes back unchanged, apart from a trailing odd byte.
 */
export function normalizePcm(pcm: Buffer, targetDb: number, peakDb = JINGLE_PEAK_DB): Buffer {
  return normalized(pcm, targetDb, peakDb).buffer;
}

function normalized(
  pcm: Buffer,
  targetDb: number,
  peakDb: number,
): { buffer: Buffer; silent: boolean } {
  const source = samplesOf(pcm);
  const level: Level = { sum: 0, peak: 0 };
  measure(source, 0, source.length, level);
  const fit = fitGain(level, source.length, targetDb, peakDb);
  if (!fit) return { buffer: Buffer.from(pcm.subarray(0, source.length * 2)), silent: true };
  const { buffer, view } = blankPcm(source.length);
  scale(source, view, fit, 0, source.length);
  return { buffer, silent: false };
}

/** `normalized`, two seconds at a time. */
async function normalizedAsync(
  pcm: Buffer,
  targetDb: number,
  peakDb: number,
): Promise<{ buffer: Buffer; silent: boolean }> {
  const source = samplesOf(pcm);
  const level: Level = { sum: 0, peak: 0 };
  const size = CHUNK_FRAMES * 2;
  await eachChunkAsync(source.length, size, (from, to) => measure(source, from, to, level));
  const fit = fitGain(level, source.length, targetDb, peakDb);
  if (!fit) return { buffer: Buffer.from(pcm.subarray(0, source.length * 2)), silent: true };
  const { buffer, view } = blankPcm(source.length);
  await eachChunkAsync(source.length, size, (from, to) => scale(source, view, fit, from, to));
  return { buffer, silent: false };
}

/**
 * Remember `pcm` under `key`, dropping the oldest entries until `cap` holds.
 * A clip bigger than the cap is not stored. Returns the new total.
 */
export function storeClip(cache: PcmCache, key: string, pcm: Buffer, cap: number): number {
  const previous = cache.bytes.get(key);
  if (previous) {
    cache.total -= previous.length;
    cache.bytes.delete(key);
  }
  if (pcm.length === 0 || pcm.length > cap) return cache.total;
  while (cache.total + pcm.length > cap && cache.bytes.size > 0) {
    const oldest = cache.bytes.keys().next().value;
    if (oldest === undefined) break;
    const gone = cache.bytes.get(oldest);
    cache.bytes.delete(oldest);
    cache.total -= gone?.length ?? 0;
  }
  cache.bytes.set(key, pcm);
  cache.total += pcm.length;
  return cache.total;
}

/**
 * Add `bed` under the spoken ranges of `voice`. The bed is normalized to
 * {@link BED_TARGET_DB} first. It fades to silence over {@link BED_FADE_SEC}
 * beside every other range, and loops with a 1 s crossfade when `voice` is
 * longer than it is. A sample that would pass the rails is clamped.
 */
export function mixBed(voice: Buffer, ranges: readonly MixRange[], bed: Buffer): Buffer {
  if (voice.length < FRAME || bed.length < FRAME) return voice;
  const level = normalized(bed, BED_TARGET_DB, JINGLE_PEAK_DB);
  if (level.silent) return voice;
  const mix = prepareMix(voice, ranges, level.buffer);
  if (!mix) return voice;
  eachChunk(mix.frames, mix.frames, (from, to) => mixFrames(mix, from, to));
  return mix.buffer;
}

/**
 * `mixBed`, two seconds of audio at a time, so the songs on air keep playing
 * while a 3-minute break is mixed. The station uses this one.
 */
export async function mixBedAsync(
  voice: Buffer,
  ranges: readonly MixRange[],
  bed: Buffer,
): Promise<Buffer> {
  if (voice.length < FRAME || bed.length < FRAME) return voice;
  const level = await normalizedAsync(bed, BED_TARGET_DB, JINGLE_PEAK_DB);
  if (level.silent) return voice;
  const mix = prepareMix(voice, ranges, level.buffer);
  if (!mix) return voice;
  await eachChunkAsync(mix.frames, CHUNK_FRAMES, (from, to) => mixFrames(mix, from, to));
  return mix.buffer;
}

/** Everything one mix needs, so it can run in chunks. */
interface BedMix {
  frames: number;
  bedFrames: number;
  gains: Float32Array;
  dry: Int16Array;
  wet: Int16Array;
  buffer: Buffer;
  view: Int16Array;
  xfade: number;
  loops: boolean;
}

function prepareMix(voice: Buffer, ranges: readonly MixRange[], level: Buffer): BedMix | null {
  const frames = Math.floor(voice.length / FRAME);
  const bedFrames = Math.floor(level.length / FRAME);
  if (frames === 0 || bedFrames === 0) return null;
  const { buffer, view } = blankPcm(frames * 2);
  const xfade = Math.min(Math.round(BED_LOOP_FADE_SEC * RATE), Math.floor(bedFrames / 2));
  return {
    frames,
    bedFrames,
    gains: bedEnvelope(silentFrames(ranges, frames), frames, Math.round(BED_FADE_SEC * RATE)),
    dry: samplesOf(voice),
    wet: samplesOf(level),
    buffer,
    view,
    xfade,
    loops: xfade >= 8 && frames > bedFrames - xfade,
  };
}

/** Mix frames `[from, to)` of `mix` into its output. */
function mixFrames(mix: BedMix, from: number, to: number): void {
  const { bedFrames, gains, dry, wet, view, xfade, loops } = mix;
  const period = bedFrames - xfade;
  for (let frame = from; frame < to; frame += 1) {
    const at = frame * 2;
    const gain = gains[frame]!;
    if (gain <= 0) {
      view[at] = dry[at]!;
      view[at + 1] = dry[at + 1]!;
      continue;
    }
    let left: number;
    let right: number;
    if (!loops || frame < bedFrames - xfade) {
      const from = (frame % bedFrames) * 2;
      left = wet[from]!;
      right = wet[from + 1]!;
    } else {
      // Past the first pass, the tail fades into the head over `xfade` frames.
      const pos = (frame - (bedFrames - xfade)) % period;
      if (pos >= xfade) {
        left = wet[pos * 2]!;
        right = wet[pos * 2 + 1]!;
      } else {
        const fadeIn = pos / xfade;
        const fadeOut = 1 - fadeIn;
        const tail = (bedFrames - xfade + pos) * 2;
        const head = pos * 2;
        left = wet[tail]! * fadeOut + wet[head]! * fadeIn;
        right = wet[tail + 1]! * fadeOut + wet[head + 1]! * fadeIn;
      }
    }
    view[at] = clamp16(dry[at]! + left * gain);
    view[at + 1] = clamp16(dry[at + 1]! + right * gain);
  }
}

/** `assets/fm/jingles`, beside `assets/kitchen-hero.jpg`. */
export function jinglesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fm', 'jingles');
}

/** The audio files in `dir`. A missing folder is an empty list. */
export function readJingleNames(dir: string): JingleFile[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: JingleFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const classified = classifyJingleName(entry.name);
    if (!classified) continue;
    files.push({ ...classified, file: resolve(dir, entry.name) });
  }
  return files;
}

/** Decode one file to s16le 48 kHz stereo. `maxSec` stops a bed early (`-t`). */
export function decodeJingleFile(file: string, maxSec?: number): Promise<Buffer> {
  if (maxSec === undefined) {
    return readFile(file).then((bytes) => decodeClip(bytes));
  }
  const command = process.env.FFMPEG_PATH || 'ffmpeg';
  const seconds = Math.max(0.1, maxSec).toFixed(3);
  const child = spawn(
    command,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-i',
      file,
      '-t',
      seconds,
      '-vn',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('FFmpeg timed out decoding a jingle.'));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => {});
    child.once('error', (error) => fail(error));
    child.once('close', (code, signal) => {
      if (signal) {
        fail(new Error(`FFmpeg exited on signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        fail(new Error(`FFmpeg exited with code ${code ?? 'unknown'}.`));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks));
    });
  });
}

/** Where decoded bytes come from. Tests hand back PCM and never call FFmpeg. */
export type JingleDecoder = (file: string, maxSec?: number) => Promise<Buffer>;

/** What the station can swap out: the folder, the clock, and the decoder. */
export interface JingleLibraryOptions {
  dir?: string;
  now?: () => number;
  decode?: JingleDecoder;
  /** Test seam. When set, the disk is not read. */
  list?: () => readonly JingleFile[];
  /** One line when a file will not decode. A missing file is quiet. */
  warn?: (message: string) => void;
}

/**
 * The owner's Suno jingles. The folder is scanned at most once a minute.
 * Short clips share a small cache. A bed is decoded for the break and dropped.
 * A missing or broken file is null, and the show carries on without it.
 */
export class JingleLibrary {
  private scannedAt = Number.NEGATIVE_INFINITY;
  private listing: readonly JingleFile[] = [];
  private readonly cache: PcmCache = { bytes: new Map(), total: 0 };
  private readonly broken = new Set<string>();

  constructor(private readonly options: JingleLibraryOptions = {}) {}

  /** The files currently in the folder. */
  files(): readonly JingleFile[] {
    const now = this.options.now?.() ?? Date.now();
    if (now - this.scannedAt < JINGLE_RESCAN_MS) return this.listing;
    this.scannedAt = now;
    try {
      this.listing = this.options.list
        ? this.options.list()
        : readJingleNames(this.options.dir ?? jinglesDir());
    } catch {
      this.listing = [];
    }
    return this.listing;
  }

  /**
   * A short jingle, normalized, from the cache when it is already decoded.
   * Null when `file` is missing or the decode fails.
   */
  async clip(file: JingleFile | null): Promise<Buffer | null> {
    if (!file) return null;
    const key = this.cacheKey(file.file);
    const hit = this.cache.bytes.get(key);
    if (hit) {
      this.cache.bytes.delete(key);
      this.cache.bytes.set(key, hit);
      return hit;
    }
    const decoded = await this.decode(file, undefined);
    if (!decoded) return null;
    const pcm = normalizePcm(decoded, JINGLE_TARGET_DB);
    storeClip(this.cache, key, pcm, JINGLE_CACHE_BYTES);
    return pcm;
  }

  /**
   * One bed, limited to about `seconds`, not cached. The mixer sets its level.
   * Null when the file will not decode.
   */
  async bed(file: JingleFile | null, seconds: number): Promise<Buffer | null> {
    if (!file) return null;
    return this.decode(file, Math.max(0.1, seconds));
  }

  private cacheKey(file: string): string {
    try {
      const stat = statSync(file);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return file;
    }
  }

  private async decode(file: JingleFile, maxSec: number | undefined): Promise<Buffer | null> {
    try {
      const pcm = await (this.options.decode ?? decodeJingleFile)(file.file, maxSec);
      if (!pcm?.length) throw new Error('no audio');
      return pcm;
    } catch {
      if (!this.broken.has(file.file)) {
        this.broken.add(file.file);
        const name = file.file.split(/[\\/]/).pop() ?? file.file;
        this.options.warn?.(`Kitchen FM jingle: could not play ${name}.`);
      }
      return null;
    }
  }
}

function clamp16(value: number): number {
  const rounded = Math.round(value);
  if (rounded > 32_767) return 32_767;
  if (rounded < -32_768) return -32_768;
  return rounded;
}

function silentFrames(
  ranges: readonly MixRange[],
  frames: number,
): { start: number; end: number }[] {
  const silent: { start: number; end: number }[] = [];
  for (const range of ranges) {
    if (range.spoken) continue;
    const start = Math.max(0, Math.floor(range.startByte / FRAME));
    const end = Math.min(frames, Math.ceil(range.endByte / FRAME));
    if (end > start) silent.push({ start, end });
  }
  return silent;
}

/**
 * The bed's gain for every frame: 0 inside a jingle, 1 well clear of one, and a
 * ramp across the fade on both sides. Built once, not searched per frame.
 */
function bedEnvelope(
  silent: readonly { start: number; end: number }[],
  frames: number,
  fade: number,
): Float32Array {
  const gains = new Float32Array(frames).fill(1);
  for (const span of silent) {
    gains.fill(0, span.start, span.end);
    for (let step = 1; step < fade; step += 1) {
      const ramp = step / fade;
      const before = span.start - step;
      const after = span.end - 1 + step;
      if (before >= 0 && gains[before]! > ramp) gains[before] = ramp;
      if (after < frames && gains[after]! > ramp) gains[after] = ramp;
    }
  }
  return gains;
}
