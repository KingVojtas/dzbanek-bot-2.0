import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Logger } from '../core/logger';

const CONNECT_TIMEOUT_MS = 10_000;
const SPEAK_TIMEOUT_MS = 20_000;
/** A short DJ line is tens of kilobytes; anything near this is not one. */
const MAX_CLIP_BYTES = 2 * 1024 * 1024;
/** After this many misses in a row the voice rests, and lines show as text only. */
const MISSES_BEFORE_REST = 3;
const REST_MS = 10 * 60_000;

/** The text goes into SSML, so `&`, `<`, and `>` in a song title must not end it. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Reads DJ lines aloud with Microsoft Edge's read-aloud voices. The clip comes
 * back whole as WebM/Opus, which Discord plays without FFmpeg. Microsoft
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
    const tts = new MsEdgeTTS({
      connectionTimeoutMs: CONNECT_TIMEOUT_MS,
      synthesisTimeoutMs: SPEAK_TIMEOUT_MS,
    });
    try {
      await tts.setMetadata(this.voiceName, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
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
      this.misses = 0;
      return size > 0 ? Buffer.concat(chunks) : null;
    } catch (error) {
      this.misses += 1;
      if (this.misses >= MISSES_BEFORE_REST) {
        this.misses = 0;
        this.restUntil = Date.now() + REST_MS;
        this.logger.warn(
          `Kitchen FM voice (${this.voiceName}) failed ${MISSES_BEFORE_REST} times; lines are text only for ${REST_MS / 60_000} minutes:`,
          error,
        );
      } else {
        this.logger.debug('Kitchen FM voice failed once:', error);
      }
      return null;
    } finally {
      tts.close();
    }
  }
}
