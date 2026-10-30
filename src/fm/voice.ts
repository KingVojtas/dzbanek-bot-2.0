import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Logger } from '../core/logger';

/** A stuck handshake is dropped. A line connects in about a second. */
const CONNECT_TIMEOUT_MS = 4_000;
/** No audio for this long ends the attempt. A 26-word line is spoken in about a second. */
const SPEAK_TIMEOUT_MS = 10_000;
/** No audio byte for this long starts another attempt beside that one. */
export const HEDGE_MS = 3_000;
/**
 * How long one line may keep trying. The opener and a dedication wait 25 s,
 * and a later intro is prepared during the song before it.
 */
export const SPEAK_BUDGET_MS = 20_000;
/** One speak places at most this many calls, and at most two of them at once. */
export const MAX_ATTEMPTS = 6;
const MAX_IN_FLIGHT = 2;
/** After a dropped attempt, wait this long before the next call. */
export const RETRY_PAUSE_MS = 500;
const DECODE_TIMEOUT_MS = 15_000;
/** A short DJ line is tens of kilobytes; anything near this is not one. */
const MAX_CLIP_BYTES = 2 * 1024 * 1024;
/** After this many misses in a row the voice rests, and lines show as text only. */
const MISSES_BEFORE_REST = 3;
const REST_MS = 10 * 60_000;
/** Quieter than this is silence, not a voice, and counts as a miss. */
const MIN_LOUDNESS_DB = -50;

/** The text goes into SSML, so `&`, `<`, and `>` in a song title must not end it. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * RMS loudness of s16le PCM, in dBFS. A silent buffer is negative infinity.
 * Full scale is the signed 16-bit peak.
 */
export function pcmLoudness(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = pcm.readInt16LE(i * 2);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  if (rms === 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(rms / 32_768);
}

/**
 * Decode an MP3 clip to PCM s16le, 48 kHz, stereo. MP3 goes in on stdin, which
 * is the FFmpeg path that works on the Mac mini. Rejects on a bad exit, a
 * signal, or if the decode takes longer than 15 seconds.
 */
export async function decodeClip(mp3: Buffer): Promise<Buffer> {
  const command = process.env.FFMPEG_PATH || 'ffmpeg';
  const { FFMPEG_MP3_PIPE_ARGS } = await import('../radio/ffmpeg-bin');
  const child = spawn(command, [...FFMPEG_MP3_PIPE_ARGS], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
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
      fail(new Error('FFmpeg timed out decoding the DJ clip.'));
    }, DECODE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
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
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(mp3);
  });
}

/** One Edge call: when the first byte arrives, the whole clip, and how to stop it. */
export interface SynthesisAttempt {
  /** Resolves on the first audio byte. Rejects if the attempt ends before that. */
  heard: Promise<void>;
  /** The whole MP3. Rejects on failure. */
  audio: Promise<Buffer>;
  close(): void;
}

/** Which attempt spoke, and why the first one did not when a later one won. */
export interface AudioRace {
  buffer: Buffer;
  /** The attempt that produced `buffer`, counting from 1. */
  attempt: number;
  /** Why the first attempt did not win. Null when attempt 1 won. */
  attempt1Note: string | null;
}

/** Knobs for one race. Tests pass a clock; `speak` passes the line's budget. */
export interface RaceOptions {
  budgetMs?: number;
  maxAttempts?: number;
  pauseMs?: number;
  now?: () => number;
  /** Called once per attempt that fails on its own, not when the race closes it. */
  onFail?: (attempt: number, elapsedMs: number, error: unknown) => void;
}

/** The info line for one spoken clip: how long Edge took, and which attempt won. */
export function voiceTimingLine(
  elapsedMs: number,
  attempt: number,
  attempt1Note: string | null,
): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  const head = `Kitchen FM voice: Edge ${seconds} s (attempt ${attempt}`;
  if (attempt <= 1 || !attempt1Note) return `${head})`;
  return `${head}; attempt 1: ${attempt1Note})`;
}

/** Why a speak gave up. One of these is one miss, however many calls it spent. */
class SpeakMiss extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly elapsedMs: number,
  ) {
    super(message);
    this.name = 'SpeakMiss';
  }
}

/**
 * The first clip to arrive. A silent attempt gets one sibling after `hedgeMs`.
 * A failed attempt is replaced after a short pause. At most two run at once,
 * and at most `maxAttempts` run in all, until the budget is spent. The loser
 * is closed.
 *
 * `wait` must not settle synchronously: the race registers every timer on it.
 */
export function firstAudio(
  start: () => SynthesisAttempt,
  hedgeMs: number,
  wait: (ms: number) => Promise<void> = delay,
  options: RaceOptions = {},
): Promise<AudioRace> {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? SPEAK_BUDGET_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const pauseMs = options.pauseMs ?? RETRY_PAUSE_MS;
  const onFail = options.onFail;

  return new Promise((resolve, reject) => {
    const startedAt = now();
    const deadline = startedAt + budgetMs;
    let finished = false;
    let inFlight = 0;
    let startedCount = 0;
    let earlierNote: string | null = null;
    let lastError: Error = new Error('the time budget ran out');
    const slots: { heard: boolean; failed: boolean; close: () => void }[] = [];

    const closeAll = () => {
      for (const slot of slots) {
        try {
          slot.close();
        } catch {
          // Already stopped.
        }
      }
    };

    const giveUp = () => {
      if (finished) return;
      finished = true;
      const miss = new SpeakMiss(lastError.message, startedCount, now() - startedAt);
      closeAll();
      reject(miss);
    };

    const win = (buffer: Buffer, attempt: number) => {
      if (finished) return;
      finished = true;
      closeAll();
      resolve({
        buffer,
        attempt,
        attempt1Note: attempt === 1 ? null : earlierNote,
      });
    };

    const arm = (ms: number, fn: () => void) => {
      void wait(ms).then(() => {
        if (!finished) fn();
      });
    };

    const remember = (reason: string) => {
      if (earlierNote === null) earlierNote = reason;
    };

    const startAttempt = (reason: string | null): void => {
      if (
        finished ||
        inFlight >= MAX_IN_FLIGHT ||
        startedCount >= maxAttempts ||
        now() >= deadline
      ) {
        return;
      }
      let attempt: SynthesisAttempt;
      try {
        attempt = start();
      } catch (error) {
        startedCount += 1;
        const wrapped = error instanceof Error ? error : new Error(errorText(error));
        lastError = wrapped;
        remember(wrapped.message);
        onFail?.(startedCount, 0, wrapped);
        if (startedCount >= maxAttempts || now() >= deadline) {
          if (inFlight === 0) giveUp();
          return;
        }
        arm(pauseMs, () => {
          startAttempt(wrapped.message);
          if (!finished && inFlight === 0) giveUp();
        });
        return;
      }

      startedCount += 1;
      inFlight += 1;
      const attemptNo = startedCount;
      const began = now();
      if (reason) remember(reason);
      const slot = { heard: false, failed: false, close: () => attempt.close() };
      slots.push(slot);

      void attempt.heard.then(
        () => {
          slot.heard = true;
        },
        () => {},
      );

      // A call that is still open and silent shares the work with one more.
      arm(hedgeMs, () => {
        if (slot.failed || slot.heard) return;
        startAttempt(hedgeNote(hedgeMs));
      });

      void attempt.audio.then(
        (buffer) => win(buffer, attemptNo),
        (error: unknown) => {
          if (finished || slot.failed) return;
          slot.failed = true;
          inFlight -= 1;
          const wrapped = error instanceof Error ? error : new Error(errorText(error));
          lastError = wrapped;
          remember(wrapped.message);
          onFail?.(attemptNo, Math.max(0, now() - began), wrapped);
          if (startedCount >= maxAttempts || now() >= deadline) {
            if (inFlight === 0) giveUp();
            return;
          }
          arm(pauseMs, () => {
            startAttempt(wrapped.message);
            if (!finished && inFlight === 0) giveUp();
          });
        },
      );
    };

    arm(budgetMs, () => giveUp());
    startAttempt(null);
    if (!finished && startedCount === 0) giveUp();
  });
}

function hedgeNote(hedgeMs: number): string {
  const seconds = hedgeMs / 1000;
  const text = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
  return `no audio after ${text} s`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One Edge synthesis. `close` drops the socket so a losing attempt stops. */
function openEdgeAttempt(voiceName: string, text: string): SynthesisAttempt {
  const tts = new MsEdgeTTS({
    connectionTimeoutMs: CONNECT_TIMEOUT_MS,
    synthesisTimeoutMs: SPEAK_TIMEOUT_MS,
  });
  let closed = false;
  let heardSettled = false;
  let resolveHeard: () => void = () => {};
  let rejectHeard: (error: Error) => void = () => {};
  const heard = new Promise<void>((resolve, reject) => {
    resolveHeard = resolve;
    rejectHeard = reject;
  });
  heard.catch(() => {});

  const markHeard = () => {
    if (heardSettled) return;
    heardSettled = true;
    resolveHeard();
  };
  const markUnheard = (error: Error) => {
    if (heardSettled) return;
    heardSettled = true;
    rejectHeard(error);
  };

  const audio = (async () => {
    try {
      await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      if (closed) throw new Error('Edge attempt closed.');
      const { audioStream } = tts.toStream(escapeXml(text));
      // A late socket error must not become an unhandled 'error' event.
      audioStream.on('error', () => {});
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of audioStream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (bytes.length > 0) markHeard();
        size += bytes.length;
        if (size > MAX_CLIP_BYTES) throw new Error('The DJ clip is too long.');
        chunks.push(bytes);
      }
      if (size === 0) throw new Error('Edge returned no audio.');
      return Buffer.concat(chunks);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      markUnheard(wrapped);
      throw wrapped;
    } finally {
      tts.close();
    }
  })();

  return {
    heard,
    audio,
    close() {
      if (closed) return;
      closed = true;
      markUnheard(new Error('Edge attempt closed.'));
      tts.close();
    },
  };
}

/** Test seams. Production uses Edge, FFmpeg, and the real clock. */
interface VoiceHooks {
  decode?: (mp3: Buffer) => Promise<Buffer>;
  now?: () => number;
  /** Must not settle synchronously. See `firstAudio`. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Reads DJ lines aloud with Microsoft Edge's read-aloud voices. The clip comes
 * back as MP3 and is decoded to PCM, the same way the radio plays. Microsoft
 * changes this service now and then; a failure means a text-only line, never
 * a stopped show.
 */
export class DjVoice {
  private misses = 0;
  private restUntil = 0;

  constructor(
    private readonly voiceName: string,
    private readonly logger: Logger,
    private readonly openAttempt: (text: string) => SynthesisAttempt = (text) =>
      openEdgeAttempt(voiceName, text),
    private readonly hooks: VoiceHooks = {},
  ) {}

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  /**
   * Read `text` aloud. Dropped calls are tried again until `budgetMs`.
   * Null is a text-only line, never a thrown error.
   */
  async speak(text: string, budgetMs = SPEAK_BUDGET_MS): Promise<Buffer | null> {
    if (!text || this.now() < this.restUntil) return null;
    const started = this.now();
    let race: AudioRace | null = null;
    try {
      race = await firstAudio(() => this.openAttempt(text), HEDGE_MS, this.hooks.wait ?? delay, {
        budgetMs,
        now: () => this.now(),
        onFail: (attempt, elapsedMs, error) => {
          const seconds = (elapsedMs / 1000).toFixed(1);
          this.logger.info(
            `Kitchen FM voice (${this.voiceName}): attempt ${attempt} failed after ${seconds} s: ${errorText(error)}`,
          );
        },
      });
      const elapsedMs = this.now() - started;
      const decode = this.hooks.decode ?? decodeClip;
      const pcm = await decode(race.buffer);
      if (pcm.length === 0 || pcmLoudness(pcm) < MIN_LOUDNESS_DB) {
        throw new SpeakMiss('The DJ clip is silent.', race.attempt, elapsedMs);
      }
      this.misses = 0;
      this.logger.info(voiceTimingLine(elapsedMs, race.attempt, race.attempt1Note));
      return pcm;
    } catch (error) {
      const miss = error instanceof SpeakMiss ? error : null;
      this.noteMiss(
        miss ?? error,
        miss?.attempts ?? race?.attempt ?? 1,
        miss?.elapsedMs ?? this.now() - started,
      );
      return null;
    }
  }

  /** One speak that gave up. After a few in a row the voice rests and lines stay on the card. */
  private noteMiss(error: unknown, attempts: number, elapsedMs: number): void {
    const seconds = (elapsedMs / 1000).toFixed(1);
    const noun = attempts === 1 ? 'attempt' : 'attempts';
    this.logger.info(
      `Kitchen FM voice: text only: ${attempts} ${noun} failed in ${seconds} s, last: ${errorText(error)}`,
    );
    this.misses += 1;
    if (this.misses < MISSES_BEFORE_REST) return;
    this.misses = 0;
    this.restUntil = this.now() + REST_MS;
    this.logger.warn(
      `Kitchen FM voice (${this.voiceName}) failed ${MISSES_BEFORE_REST} times; lines are text only for ${REST_MS / 60_000} minutes:`,
      error,
    );
  }
}
