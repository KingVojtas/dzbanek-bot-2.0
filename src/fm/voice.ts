import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Logger } from '../core/logger';

/** A stuck handshake is dropped. A line connects in about a second. */
const CONNECT_TIMEOUT_MS = 4_000;
/** No audio for this long ends the attempt. A 26-word line is spoken in about a second. */
const SPEAK_TIMEOUT_MS = 10_000;
/** No audio byte for this long starts a second attempt beside the first. */
export const HEDGE_MS = 3_000;
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

/** Which attempt spoke, and why the first one did not when the second won. */
export interface AudioRace {
  buffer: Buffer;
  attempt: 1 | 2;
  attempt1Note: string | null;
}

/** The info line for one spoken clip: how long Edge took, and which attempt won. */
export function voiceTimingLine(
  elapsedMs: number,
  attempt: 1 | 2,
  attempt1Note: string | null,
): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  if (attempt === 1) return `Kitchen FM voice: Edge ${seconds} s (attempt 1)`;
  return `Kitchen FM voice: Edge ${seconds} s (attempt 2; attempt 1: ${attempt1Note})`;
}

/**
 * The first clip to arrive. A second attempt starts when the first fails or
 * sends no audio for `hedgeMs`. The loser is closed. Never a third attempt.
 */
export function firstAudio(
  start: () => SynthesisAttempt,
  hedgeMs: number,
  wait: (ms: number) => Promise<void> = delay,
): Promise<AudioRace> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let second: SynthesisAttempt | null = null;
    let heardAudio = false;
    // The race is lost only when every attempt that started has failed.
    let firstFailed = false;
    let secondFailed = false;
    let note = hedgeNote(hedgeMs);
    const first = start();

    const closeBoth = () => {
      try {
        first.close();
      } catch {
        // Already stopped.
      }
      try {
        second?.close();
      } catch {
        // Already stopped.
      }
    };

    const win = (buffer: Buffer, attempt: 1 | 2) => {
      if (finished) return;
      finished = true;
      closeBoth();
      resolve({ buffer, attempt, attempt1Note: attempt === 2 ? note : null });
    };

    const lose = (error: unknown) => {
      if (finished) return;
      finished = true;
      closeBoth();
      reject(error instanceof Error ? error : new Error(errorText(error)));
    };

    const armSecond = (why: string) => {
      if (finished || second) return;
      note = why;
      try {
        second = start();
      } catch (error) {
        lose(error);
        return;
      }
      second.audio.then(
        (buffer) => win(buffer, 2),
        (error: unknown) => {
          secondFailed = true;
          // A slow first attempt may still finish.
          if (firstFailed) lose(error);
        },
      );
    };

    void first.heard.then(
      () => {
        heardAudio = true;
      },
      () => {},
    );

    first.audio.then(
      (buffer) => win(buffer, 1),
      (error: unknown) => {
        firstFailed = true;
        if (finished) return;
        if (!second) armSecond(errorText(error));
        else if (secondFailed) lose(error);
      },
    );

    void wait(hedgeMs).then(() => {
      if (finished || heardAudio || second) return;
      armSecond(hedgeNote(hedgeMs));
    });
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
  ) {}

  async speak(text: string): Promise<Buffer | null> {
    if (!text || Date.now() < this.restUntil) return null;
    const started = Date.now();
    try {
      // A slow or dropped Edge call gets one parallel retry. The first clip wins.
      const race = await firstAudio(() => this.openAttempt(text), HEDGE_MS);
      const elapsedMs = Date.now() - started;
      const pcm = await decodeClip(race.buffer);
      if (pcm.length === 0 || pcmLoudness(pcm) < MIN_LOUDNESS_DB) {
        throw new Error('The DJ clip is silent.');
      }
      this.misses = 0;
      this.logger.info(voiceTimingLine(elapsedMs, race.attempt, race.attempt1Note));
      return pcm;
    } catch (error) {
      this.noteMiss(error);
      return null;
    }
  }

  /** One miss. After a few in a row the voice rests and lines stay on the card. */
  private noteMiss(error: unknown): void {
    this.misses += 1;
    if (this.misses >= MISSES_BEFORE_REST) {
      this.misses = 0;
      this.restUntil = Date.now() + REST_MS;
      this.logger.warn(
        `Kitchen FM voice (${this.voiceName}) failed ${MISSES_BEFORE_REST} times; lines are text only for ${REST_MS / 60_000} minutes:`,
        error,
      );
      return;
    }
    this.logger.debug('Kitchen FM voice failed once:', error);
  }
}
