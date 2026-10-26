import { spawn } from 'node:child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Logger } from '../core/logger';

/** A stuck handshake is dropped so the one retry can start. A line connects in about a second. */
const CONNECT_TIMEOUT_MS = 4_000;
/** No audio for this long ends the attempt. A 26-word line is spoken in about a second. */
const SPEAK_TIMEOUT_MS = 10_000;
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
  ) {}

  async speak(text: string): Promise<Buffer | null> {
    if (!text || Date.now() < this.restUntil) return null;
    try {
      // Edge drops a connection now and then; one fresh try usually gets the line.
      const mp3 = await this.synthesize(text).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.info(`Kitchen FM voice: first try failed: ${message}`);
        return this.synthesize(text);
      });
      const pcm = await decodeClip(mp3);
      if (pcm.length === 0 || pcmLoudness(pcm) < MIN_LOUDNESS_DB) {
        throw new Error('The DJ clip is silent.');
      }
      this.misses = 0;
      return pcm;
    } catch (error) {
      this.noteMiss(error);
      return null;
    }
  }

  /** The line as MP3 from Edge. Throws on a failed or empty answer. */
  private async synthesize(text: string): Promise<Buffer> {
    const tts = new MsEdgeTTS({
      connectionTimeoutMs: CONNECT_TIMEOUT_MS,
      synthesisTimeoutMs: SPEAK_TIMEOUT_MS,
    });
    try {
      await tts.setMetadata(this.voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(escapeXml(text));
      // A late socket error must not become an unhandled 'error' event.
      audioStream.on('error', () => {});
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of audioStream) {
        size += (chunk as Buffer).length;
        if (size > MAX_CLIP_BYTES) throw new Error('The DJ clip is too long.');
        chunks.push(chunk as Buffer);
      }
      if (size === 0) throw new Error('Edge returned no audio.');
      return Buffer.concat(chunks);
    } finally {
      tts.close();
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
