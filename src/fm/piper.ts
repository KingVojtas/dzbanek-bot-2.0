import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setPriority as osSetPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '../core/logger';
import { normalizePcm } from './jingles';
import { extractTarGz } from './piper-archive';
import {
  PIPER_BINARY,
  PIPER_RELEASE,
  PIPER_VOICES,
  DEFAULT_PIPER_VOICE,
  type PinnedFile,
} from './piper-pins';
import { DjVoice, MIN_LOUDNESS_DB, SPEAK_BUDGET_MS, pcmLoudness, type DjSpeaker } from './voice';

/** Edge clips sit near this. Piper peaks at full scale, so each line is pulled down. */
export const PIPER_TARGET_DB = -24;
/** Nothing in a Piper line is allowed to reach this. */
export const PIPER_PEAK_DB = -1;
/** One file, this many times, then the install gives up on it. */
const DOWNLOAD_TRIES = 3;
const DOWNLOAD_BACKOFF_MS = [0, 1_000, 2_000];
/** A voice model is about 115 MB. Five minutes still finishes on a slow link. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** Raw s16le at 22050 Hz. Six minutes of speech stays under this. */
const MAX_RAW_BYTES = 16 * 1024 * 1024;
/** Hourly, and only a few times: a missing library will not appear on the fifth try. */
const RETRY_MS = 60 * 60_000;
const RETRY_LIMIT = 3;
const CHECK_LINE = 'Kitchen FM check.';

/** The `dj` fields Piper cares about. */
export interface DjVoiceSettings {
  language: 'en' | 'cs';
  engine: 'piper' | 'edge';
  voice: string;
  jingleVoice: string;
  piperVoice: string;
  piperJingleVoice: string;
  piperLengthScale: number;
}

/**
 * English spellings for names eSpeak reads wrong. It spells a leading "dz" as
 * letters, so "dzbanek" came out "dee-zee-bay-nuk" (dˌiːzˈiːbˈeɪnək).
 * "D'zbahneck" is dəzbˈɑːnɛk in both the US and the British voices.
 */
const SPOKEN_AS: ReadonlyArray<readonly [RegExp, string]> = [[/\bdzb[aá]nek/giu, "D'zbahneck"]];

/** Bump when `SPOKEN_AS` changes, so clips stored with the old reading are made again. */
const PRONUNCIATION_VERSION = 2;

/** `text` with the names in `SPOKEN_AS` respelled for Piper. */
export function respellForPiper(text: string): string {
  return SPOKEN_AS.reduce((line, [pattern, spoken]) => line.replace(pattern, spoken), text);
}

/**
 * What a prepared line was voiced with. Piper keeps its own name, so switching
 * back to Edge (or to another Piper voice) drops the stored clip. So does a new
 * `PRONUNCIATION_VERSION`.
 * Czech has no pinned voice, so the identity stays the Edge voice.
 */
export function djVoiceIdentity(dj: {
  language: string;
  engine?: string;
  voice: string;
  piperVoice?: string;
}): string {
  if (dj.language === 'cs' || dj.engine !== 'piper') return dj.voice;
  return `piper:${dj.piperVoice || DEFAULT_PIPER_VOICE};say${PRONUNCIATION_VERSION}`;
}

/** `audio.sample_rate` from a Piper `.onnx.json`. */
export function sampleRateOf(json: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Piper voice config is not JSON.');
  }
  const rate = (parsed as { audio?: { sample_rate?: unknown } } | null)?.audio?.sample_rate;
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 8_000 || rate > 96_000) {
    throw new Error('Piper voice config has no sample rate.');
  }
  return rate;
}

/**
 * One spoken line. Piper reads stdin to the newline, and a song title can
 * carry emoji and line breaks from the card. Names eSpeak gets wrong are respelled.
 */
export function cleanPiperText(text: string): string {
  return respellForPiper(text)
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\u200D|\uFE0F|[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves when `speaker` has finished starting, or after `maxMs`.
 * A speaker with no `ready` (Edge) is already settled.
 */
export function waitForReady(
  speaker: { ready?: () => Promise<void> },
  maxMs: number,
): Promise<void> {
  let pending: Promise<void> | undefined;
  try {
    pending = speaker.ready?.();
  } catch {
    return Promise.resolve();
  }
  if (!pending) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    timer.unref?.();
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void pending.then(finish, finish);
  });
}

/** One Piper process at a time, so a long break does not stack synthesizers. */
export class PiperQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** The slice of a child process Piper and the tests both use. */
export interface SpawnedPiper {
  pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  once(event: 'error', listener: (error: Error) => void): void;
}

export type PiperSpawn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => SpawnedPiper;

interface PipeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  tooLong: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stderrTail(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.slice(-4).join('; ').slice(0, 180);
}

function bytesLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${bytes} B`;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnedPiper {
  const child: ChildProcess = spawn(command, [...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error('Piper stdio is not a pipe.');
  }
  return child as SpawnedPiper;
}

/**
 * Write `input` to the child and collect stdout. The deadline kills it, so a
 * line that waits in the queue cannot run on after its budget.
 */
function runPipe(
  child: SpawnedPiper,
  input: Buffer | string,
  deadline: number,
  now: () => number,
  wait: (ms: number) => Promise<void>,
): Promise<PipeResult> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let stderr = '';
    let size = 0;
    let settled = false;
    let timedOut = false;
    let tooLong = false;
    const finish = (result: PipeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_RAW_BYTES) {
        tooLong = true;
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        return;
      }
      out.push(buf);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      finish({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr,
        timedOut,
        tooLong,
      });
    });
    child.stdin.write(input);
    child.stdin.end();
    const remaining = Math.max(0, deadline - now());
    void wait(remaining).then(() => {
      if (settled || now() < deadline) return;
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    });
  });
}

/** Raw s16le mono at `sampleRate` to s16le 48 kHz stereo, the radio's format. */
async function resampleRaw(
  raw: Buffer,
  sampleRate: number,
  deadline: number,
  now: () => number,
  wait: (ms: number) => Promise<void>,
): Promise<Buffer> {
  if (now() >= deadline) throw new Error('the time budget ran out');
  const command = process.env.FFMPEG_PATH || 'ffmpeg';
  const child = spawn(
    command,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-vn',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error('FFmpeg stdio is not a pipe.');
  }
  const result = await runPipe(child as SpawnedPiper, raw, deadline, now, wait);
  if (result.timedOut) throw new Error('the time budget ran out');
  if (result.code !== 0) {
    const tail = stderrTail(result.stderr);
    throw new Error(tail || `FFmpeg exited with code ${result.code ?? 'unknown'}.`);
  }
  return result.stdout;
}

export interface PiperVoiceOptions {
  voiceName: string;
  binary: string;
  model: string;
  configPath: string;
  espeakData: string;
  lengthScale: number;
  sampleRate: number;
  logger: Logger;
  spawn?: PiperSpawn;
  /** Raw mono in, 48 kHz stereo PCM out. Tests skip FFmpeg. The deadline kills a slow decode. */
  resample?: (
    raw: Buffer,
    sampleRate: number,
    deadline: number,
    now: () => number,
    wait: (ms: number) => Promise<void>,
  ) => Promise<Buffer>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  setPriority?: (pid: number, priority: number) => void;
  queue?: PiperQueue;
  /** The install stop hook kills the child that is speaking. */
  trackChild?: (kill: (() => void) | null) => void;
}

/**
 * One Piper voice. `speak` never throws: null is a text-only line, the same
 * contract as Edge. One process per line, through `queue` when several voices share it.
 */
export class PiperVoice implements DjSpeaker {
  readonly voiceName: string;
  private miss = '';
  private factor: number | null = null;
  private readonly queue: PiperQueue;

  constructor(private readonly options: PiperVoiceOptions) {
    this.voiceName = options.voiceName;
    this.queue = options.queue ?? new PiperQueue();
  }

  lastMiss(): string {
    return this.miss;
  }

  /** Synth time divided by speech time. Null until a line has been spoken. */
  speed(): number | null {
    return this.factor;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private fail(reason: string): null {
    this.miss = reason.replace(/\s+/g, ' ').trim().slice(0, 180);
    return null;
  }

  /**
   * Read `text` aloud. The budget includes time spent waiting for the one
   * Piper process. Null is a text-only line.
   */
  speak(text: string, budgetMs = SPEAK_BUDGET_MS): Promise<Buffer | null> {
    const deadline = this.now() + budgetMs;
    return this.queue.run(() => this.render(text, deadline));
  }

  private async render(text: string, deadline: number): Promise<Buffer | null> {
    const line = cleanPiperText(text);
    if (!line) return this.fail('The line is empty.');
    if (this.now() >= deadline) return this.fail('the time budget ran out');
    const wait = this.options.wait ?? delay;
    const spawnPiper = this.options.spawn ?? defaultSpawn;
    const libDir = dirname(this.options.binary);
    const previous = process.env.LD_LIBRARY_PATH;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LD_LIBRARY_PATH: previous ? `${libDir}:${previous}` : libDir,
    };
    const args = [
      '--model',
      this.options.model,
      '--config',
      this.options.configPath,
      '--output-raw',
      '--espeak_data',
      this.options.espeakData,
      '--length_scale',
      String(this.options.lengthScale),
      '-q',
    ];
    let child: SpawnedPiper;
    try {
      child = spawnPiper(this.options.binary, args, env);
    } catch (error) {
      return this.fail(errorText(error));
    }
    this.options.trackChild?.(() => child.kill());
    try {
      if (typeof child.pid === 'number') {
        try {
          (this.options.setPriority ?? osSetPriority)(child.pid, 10);
        } catch {
          // The host can refuse a priority. The line still speaks.
        }
      }
      const synthAt = this.now();
      const piped = await runPipe(child, `${line}\n`, deadline, () => this.now(), wait);
      const synthMs = Math.max(0, this.now() - synthAt);
      if (piped.timedOut) return this.fail('the time budget ran out');
      if (piped.tooLong) return this.fail('The DJ clip is too long.');
      if (piped.code !== 0) {
        const tail = stderrTail(piped.stderr);
        const code = piped.signal ? `signal ${piped.signal}` : `code ${piped.code ?? 'unknown'}`;
        return this.fail(tail || `piper exited with ${code}`);
      }
      if (piped.stdout.length < 2) return this.fail('Piper returned no audio.');
      const resample = this.options.resample ?? resampleRaw;
      let pcm: Buffer;
      try {
        pcm = await resample(
          piped.stdout,
          this.options.sampleRate,
          deadline,
          () => this.now(),
          wait,
        );
      } catch (error) {
        return this.fail(errorText(error));
      }
      const gained = normalizePcm(pcm, PIPER_TARGET_DB, PIPER_PEAK_DB);
      if (gained.length === 0 || pcmLoudness(gained) < MIN_LOUDNESS_DB) {
        return this.fail('The DJ clip is silent.');
      }
      const speechSec = Math.floor(piped.stdout.length / 2) / this.options.sampleRate;
      const factor = speechSec > 0 ? synthMs / 1000 / speechSec : 0;
      this.factor = factor;
      this.miss = '';
      const taken = (synthMs / 1000).toFixed(1);
      this.options.logger.info(
        `Kitchen FM voice: Piper ${taken} s for ${speechSec.toFixed(1)} s of speech (x${factor.toFixed(2)}, ${this.voiceName})`,
      );
      return gained;
    } finally {
      this.options.trackChild?.(null);
    }
  }
}

export interface ChainVoiceOptions {
  /** The Piper voice while it is ready. Null while it is installing or unavailable. */
  piper: () => PiperVoice | null;
  edge: DjSpeaker;
  logger: Logger;
  now?: () => number;
  /**
   * Why Piper is not speaking. Empty when the operator chose Edge.
   * `installing` is the startup wait.
   */
  fallback: () => string;
  ready: () => Promise<void>;
}

/**
 * Piper when it is ready, otherwise Edge. A Piper miss speaks the same line
 * on Edge with whatever budget is left.
 */
export class ChainVoice implements DjSpeaker {
  private readonly now: () => number;

  constructor(private readonly options: ChainVoiceOptions) {
    this.now = options.now ?? Date.now;
  }

  ready(): Promise<void> {
    return this.options.ready();
  }

  /** One line for a later status command. */
  status(): string {
    const piper = this.options.piper();
    if (piper) {
      const factor = piper.speed();
      const head = `Piper ${piper.voiceName}`;
      return factor === null ? head : `${head}, last line x${factor.toFixed(2)}`;
    }
    const why = this.options.fallback();
    if (why === '' || why === 'edge') return 'Edge';
    if (why === 'installing') return 'Edge (Piper installing)';
    return `Edge (Piper unavailable: ${why})`;
  }

  async speak(text: string, budgetMs = SPEAK_BUDGET_MS): Promise<Buffer | null> {
    try {
      const piper = this.options.piper();
      if (!piper) return await this.speakEdge(text, budgetMs);
      const started = this.now();
      const clip = await piper.speak(text, budgetMs);
      if (clip) return clip;
      const elapsed = Math.max(0, this.now() - started);
      const seconds = (elapsed / 1000).toFixed(1);
      const reason = piper.lastMiss() || 'no audio';
      this.options.logger.info(
        `Kitchen FM voice: Piper miss after ${seconds} s: ${reason}, using Edge`,
      );
      return await this.speakEdge(text, budgetMs - elapsed);
    } catch (error) {
      this.options.logger.warn('Kitchen FM voice: the line failed:', error);
      return null;
    }
  }

  private speakEdge(text: string, budgetMs: number): Promise<Buffer | null> {
    if (budgetMs <= 0) return Promise.resolve(null);
    return this.options.edge.speak(text, budgetMs);
  }
}

/** Where one release and its voices live under `data/piper`. */
export function piperPaths(root: string, release = PIPER_RELEASE) {
  const binDir = join(root, 'bin', release, 'piper');
  return {
    root,
    release,
    binDir,
    binary: join(binDir, 'piper'),
    espeak: join(binDir, 'espeak-ng-data'),
    voicesDir: join(root, 'voices'),
    marker: join(root, 'installed.json'),
    model: (name: string) => join(root, 'voices', `${name}.onnx`),
    config: (name: string) => join(root, 'voices', `${name}.onnx.json`),
  };
}

/** `data/piper` in the process working directory. Deploys leave it in place. */
export function piperRoot(): string {
  return join(process.cwd(), 'data', 'piper');
}

export interface PiperCatalog {
  release: string;
  binary: PinnedFile;
  voices: Record<string, { model: PinnedFile; config: PinnedFile }>;
}

export function defaultCatalog(): PiperCatalog {
  return { release: PIPER_RELEASE, binary: PIPER_BINARY, voices: PIPER_VOICES };
}

export interface InstallOutcome {
  ok: boolean;
  /** Empty when `ok`. Otherwise why Piper cannot be used, without the word "unavailable". */
  reason: string;
  skipped: boolean;
  /** False when another try cannot help, such as the wrong platform. */
  retry: boolean;
}

interface MarkerFile {
  release: string;
  voices: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readMarker(path: string, release: string): Promise<MarkerFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as MarkerFile;
    if (!parsed || parsed.release !== release || !Array.isArray(parsed.voices)) return null;
    return { release, voices: parsed.voices.filter((voice) => typeof voice === 'string') };
  } catch {
    return null;
  }
}

/**
 * Download one pinned file to a temp name in the same folder, check the size
 * and SHA-256, then rename it into place. Three tries, with a short backoff.
 */
async function downloadVerified(
  file: PinnedFile,
  dest: string,
  fetchImpl: typeof fetch,
  wait: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  log: (message: string) => void,
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  log(`Piper: downloading ${file.name} (${bytesLabel(file.bytes)})`);
  let last = `${file.name} download failed`;
  for (let attempt = 0; attempt < DOWNLOAD_TRIES; attempt += 1) {
    if (signal?.aborted) throw new Error('stopped');
    const pause = DOWNLOAD_BACKOFF_MS[attempt] ?? 2_000;
    if (pause > 0) await wait(pause);
    if (signal?.aborted) throw new Error('stopped');
    const partial = `${dest}.partial`;
    try {
      await downloadOnce(file, partial, fetchImpl, signal);
      await rm(dest, { force: true });
      await rename(partial, dest);
      return;
    } catch (error) {
      last = errorText(error);
      await rm(partial, { force: true }).catch(() => {});
    }
  }
  throw new Error(last);
}

async function downloadOnce(
  file: PinnedFile,
  partial: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<void> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const response = await fetchImpl(file.url, {
    signal: abort,
    headers: { 'user-agent': 'dzbanek-bot/2.0' },
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${file.name}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== file.bytes) {
    throw new Error(`${file.name} is ${declared} bytes, not ${file.bytes}`);
  }
  const hash = createHash('sha256');
  let size = 0;
  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      void encoding;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > file.bytes) {
        callback(new Error(`${file.name} is larger than ${file.bytes} bytes`));
        return;
      }
      hash.update(buf);
      callback(null, buf);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(partial));
  if (size !== file.bytes) throw new Error(`${file.name} is ${size} bytes, not ${file.bytes}`);
  const digest = hash.digest('hex');
  if (digest !== file.sha256) throw new Error(`${file.name} hash does not match`);
}

/**
 * Install the pinned Piper release and the named voices under `root`.
 * Only linux/x64. A later call with the marker in place does not download again.
 * Nothing outside `root` is written.
 */
export async function installPiper(options: {
  root: string;
  voices: readonly string[];
  catalog?: PiperCatalog;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** Download again even when the marker matches. A failed smoke test asks for this. */
  force?: boolean;
}): Promise<InstallOutcome> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'linux' || arch !== 'x64') {
    return { ok: false, reason: `${platform}/${arch}`, skipped: false, retry: false };
  }
  const catalog = options.catalog ?? defaultCatalog();
  for (const name of options.voices) {
    if (!catalog.voices[name]) {
      return { ok: false, reason: `unknown voice ${name}`, skipped: false, retry: false };
    }
  }
  const fetchImpl = options.fetch ?? fetch;
  const wait = options.wait ?? delay;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const paths = piperPaths(options.root, catalog.release);
  // The Linux binary is `piper`, even when this check runs the code on Windows.
  const binary = join(paths.binDir, 'piper');
  const started = now();
  try {
    const marker = options.force ? null : await readMarker(paths.marker, catalog.release);
    const listed = marker ? options.voices.every((name) => marker.voices.includes(name)) : false;
    const ready =
      !options.force &&
      listed &&
      (await exists(binary)) &&
      (await exists(paths.espeak)) &&
      (await voicesReady(paths, options.voices));
    if (ready) return { ok: true, reason: '', skipped: true, retry: false };

    await mkdir(paths.voicesDir, { recursive: true });
    if (options.force || !(await exists(binary)) || !(await exists(paths.espeak))) {
      const tarPath = join(options.root, 'bin', `${catalog.release}.tar.gz`);
      await downloadVerified(catalog.binary, tarPath, fetchImpl, wait, options.signal, log);
      const staging = join(options.root, 'bin', `${catalog.release}.staging`);
      try {
        await rm(staging, { recursive: true, force: true });
        await extractTarGz(tarPath, staging);
        const finalDir = join(options.root, 'bin', catalog.release);
        await rm(finalDir, { recursive: true, force: true });
        await rename(staging, finalDir);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      } finally {
        await rm(tarPath, { force: true });
      }
      if (!(await exists(binary))) throw new Error('the archive has no piper binary');
      if (!(await exists(paths.espeak))) throw new Error('the archive has no espeak data');
    }
    for (const name of options.voices) {
      const pinned = catalog.voices[name];
      if (!pinned) continue;
      const model = paths.model(name);
      const config = paths.config(name);
      if (options.force || !(await exists(model))) {
        await downloadVerified(pinned.model, model, fetchImpl, wait, options.signal, log);
      }
      if (options.force || !(await exists(config))) {
        await downloadVerified(pinned.config, config, fetchImpl, wait, options.signal, log);
      }
      sampleRateOf(await readFile(config, 'utf8'));
    }
    const body = JSON.stringify(
      { release: catalog.release, voices: [...options.voices].sort() },
      null,
      2,
    );
    const partial = `${paths.marker}.partial`;
    await writeFile(partial, body);
    await rm(paths.marker, { force: true });
    await rename(partial, paths.marker);
    const seconds = ((now() - started) / 1000).toFixed(1);
    log(`Piper: installed ${catalog.release} in ${seconds} s`);
    return { ok: true, reason: '', skipped: false, retry: false };
  } catch (error) {
    const reason = errorText(error);
    return {
      ok: false,
      reason: reason === 'stopped' ? 'stopped' : reason,
      skipped: false,
      retry: reason !== 'stopped',
    };
  }
}

async function voicesReady(
  paths: ReturnType<typeof piperPaths>,
  voices: readonly string[],
): Promise<boolean> {
  for (const name of voices) {
    if (!(await exists(paths.model(name))) || !(await exists(paths.config(name)))) return false;
  }
  return true;
}

export interface PiperHooks {
  root?: string;
  fetch?: typeof fetch;
  catalog?: PiperCatalog;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Skip the download and speak with this binary. The local Windows check uses it. */
  binaryPath?: string;
  espeakData?: string;
  voicesDir?: string;
  spawn?: PiperSpawn;
  resample?: (
    raw: Buffer,
    sampleRate: number,
    deadline: number,
    now: () => number,
    wait: (ms: number) => Promise<void>,
  ) => Promise<Buffer>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  setPriority?: (pid: number, priority: number) => void;
  /** Stand-ins so a test does not open Edge. */
  edge?: DjSpeaker;
  jingleEdge?: DjSpeaker;
  /** Defaults to an hour. */
  retryMs?: number;
  /** First try plus retries. Defaults to 4. */
  maxAttempts?: number;
  schedule?: (fn: () => void, ms: number) => { clear(): void };
}

/**
 * DJ and jingle speakers. Piper installs in the background; until `ready`
 * resolves, both speak with Edge. Call `stop` on shutdown.
 */
export function openKitchenVoices(
  dj: DjVoiceSettings,
  logger: Logger,
  hooks: PiperHooks = {},
): { dj: ChainVoice; jingle: ChainVoice; stop(): void } {
  if (dj.language === 'cs') {
    logger.info('Piper: not used for Czech; Edge speaks.');
    return edgeOnly(dj, logger, hooks, 'no Czech voice');
  }
  if (dj.engine === 'edge') return edgeOnly(dj, logger, hooks, '');
  const platform = hooks.platform ?? process.platform;
  const arch = hooks.arch ?? process.arch;
  if (!hooks.binaryPath && (platform !== 'linux' || arch !== 'x64')) {
    logger.warn(`Piper unavailable: ${platform}/${arch}`);
    return edgeOnly(dj, logger, hooks, `${platform}/${arch}`);
  }

  const queue = new PiperQueue();
  const state: {
    phase: 'installing' | 'ready' | 'unavailable';
    reason: string;
    djVoice: PiperVoice | null;
    jingleVoice: PiperVoice | null;
  } = { phase: 'installing', reason: '', djVoice: null, jingleVoice: null };
  let settle: () => void = () => {};
  let settled = false;
  const ready = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  let stopped = false;
  let killChild: (() => void) | null = null;
  let timer: { clear(): void } | null = null;
  const abort = new AbortController();
  const names = [...new Set([dj.piperVoice, dj.piperJingleVoice])];
  const maxAttempts = hooks.maxAttempts ?? 1 + RETRY_LIMIT;
  let attempts = 0;
  const schedule =
    hooks.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return { clear: () => clearTimeout(handle) };
    });

  const trackChild = (kill: (() => void) | null): void => {
    killChild = kill;
  };

  const voiceOptions = (
    name: string,
    binary: string,
    espeakData: string,
    model: string,
    configPath: string,
    sampleRate: number,
  ): PiperVoiceOptions => ({
    voiceName: name,
    binary,
    model,
    configPath,
    espeakData,
    lengthScale: dj.piperLengthScale,
    sampleRate,
    logger,
    spawn: hooks.spawn,
    resample: hooks.resample,
    now: hooks.now,
    wait: hooks.wait,
    setPriority: hooks.setPriority,
    queue,
    trackChild,
  });

  async function makeVoice(
    name: string,
    binary: string,
    espeakData: string,
    model: string,
    configPath: string,
  ): Promise<PiperVoice> {
    const rate = sampleRateOf(await readFile(configPath, 'utf8'));
    return new PiperVoice(voiceOptions(name, binary, espeakData, model, configPath, rate));
  }

  function fail(reason: string, retry: boolean): void {
    state.phase = 'unavailable';
    state.djVoice = null;
    state.jingleVoice = null;
    state.reason = reason.replace(/\s+/g, ' ').trim().slice(0, 180) || 'the check line failed';
    logger.warn(`Piper unavailable: ${state.reason}`);
    settle();
    if (!retry || stopped || attempts >= maxAttempts) return;
    timer = schedule(() => {
      timer = null;
      void run();
    }, hooks.retryMs ?? RETRY_MS);
  }

  async function smoke(): Promise<void> {
    const voice = state.djVoice;
    if (!voice) {
      fail('Piper voice is missing', true);
      return;
    }
    const pcm = await voice.speak(CHECK_LINE);
    if (stopped) return;
    if (!pcm) {
      fail(voice.lastMiss() || 'the check line failed', true);
      return;
    }
    state.phase = 'ready';
    const factor = voice.speed() ?? 0;
    logger.info(`Piper ready: ${voice.voiceName}, check line x${factor.toFixed(2)}`);
    settle();
  }

  async function once(): Promise<void> {
    if (hooks.binaryPath) {
      const voicesDir = hooks.voicesDir ?? join(dirname(hooks.binaryPath), '..', 'voices');
      const espeak = hooks.espeakData ?? join(dirname(hooks.binaryPath), 'espeak-ng-data');
      state.djVoice = await makeVoice(
        dj.piperVoice,
        hooks.binaryPath,
        espeak,
        join(voicesDir, `${dj.piperVoice}.onnx`),
        join(voicesDir, `${dj.piperVoice}.onnx.json`),
      );
      state.jingleVoice = await makeVoice(
        dj.piperJingleVoice,
        hooks.binaryPath,
        espeak,
        join(voicesDir, `${dj.piperJingleVoice}.onnx`),
        join(voicesDir, `${dj.piperJingleVoice}.onnx.json`),
      );
      await smoke();
      return;
    }
    const root = hooks.root ?? piperRoot();
    const catalog = hooks.catalog ?? defaultCatalog();
    const outcome = await installPiper({
      root,
      voices: names,
      catalog,
      fetch: hooks.fetch,
      platform: hooks.platform ?? 'linux',
      arch: hooks.arch ?? 'x64',
      wait: hooks.wait,
      now: hooks.now,
      log: (message) => logger.info(message),
      signal: abort.signal,
      force: attempts > 1,
    });
    if (stopped || outcome.reason === 'stopped') {
      settle();
      return;
    }
    if (!outcome.ok) {
      fail(outcome.reason, outcome.retry);
      return;
    }
    const paths = piperPaths(root, catalog.release);
    const binary = join(paths.binDir, 'piper');
    state.djVoice = await makeVoice(
      dj.piperVoice,
      binary,
      paths.espeak,
      paths.model(dj.piperVoice),
      paths.config(dj.piperVoice),
    );
    state.jingleVoice = await makeVoice(
      dj.piperJingleVoice,
      binary,
      paths.espeak,
      paths.model(dj.piperJingleVoice),
      paths.config(dj.piperJingleVoice),
    );
    await smoke();
  }

  async function run(): Promise<void> {
    if (stopped) return;
    attempts += 1;
    if (attempts > 1) state.phase = 'installing';
    try {
      await once();
    } catch (error) {
      if (stopped || abort.signal.aborted) {
        settle();
        return;
      }
      fail(errorText(error), true);
    }
  }

  const djChain = new ChainVoice({
    piper: () => (state.phase === 'ready' ? state.djVoice : null),
    edge: hooks.edge ?? new DjVoice(dj.voice, logger),
    logger,
    now: hooks.now,
    fallback: () => (state.phase === 'installing' ? 'installing' : state.reason),
    ready: () => ready,
  });
  const jingleChain = new ChainVoice({
    piper: () => (state.phase === 'ready' ? state.jingleVoice : null),
    edge: hooks.jingleEdge ?? new DjVoice(dj.jingleVoice, logger),
    logger,
    now: hooks.now,
    fallback: () => (state.phase === 'installing' ? 'installing' : state.reason),
    ready: () => ready,
  });

  void run();
  return {
    dj: djChain,
    jingle: jingleChain,
    stop() {
      stopped = true;
      timer?.clear();
      timer = null;
      abort.abort();
      try {
        killChild?.();
      } catch {
        // Already gone.
      }
      settle();
    },
  };
}

function edgeOnly(
  dj: DjVoiceSettings,
  logger: Logger,
  hooks: PiperHooks,
  reason: string,
): { dj: ChainVoice; jingle: ChainVoice; stop(): void } {
  const ready = Promise.resolve();
  const now = hooks.now;
  const make = (edge: DjSpeaker): ChainVoice =>
    new ChainVoice({
      piper: () => null,
      edge,
      logger,
      now,
      fallback: () => reason,
      ready: () => ready,
    });
  return {
    dj: make(hooks.edge ?? new DjVoice(dj.voice, logger)),
    jingle: make(hooks.jingleEdge ?? new DjVoice(dj.jingleVoice, logger)),
    stop() {},
  };
}
