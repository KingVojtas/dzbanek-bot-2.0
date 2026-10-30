/** s16le, 48 kHz, stereo. */
export const PCM_BYTES_PER_SEC = 48_000 * 2 * 2;

/** A clip is never cut before this, even when it is shorter. */
export const INTRO_MIN_MS = 60_000;
/** Slack after the clip's own length, so Discord can finish the buffer. */
export const INTRO_MARGIN_MS = 15_000;
/** An intro longer than this, when the song was not prefetched, opens late. */
export const LONG_INTRO_SEC = 30;
/** How long before the end of a long intro the song stream opens. */
export const STREAM_LEAD_SEC = 15;

/** Length of a DJ clip in seconds. */
export function pcmSeconds(pcm: Buffer): number {
  return pcm.length / PCM_BYTES_PER_SEC;
}

/**
 * How long the player lets an intro run. At least a minute, otherwise the
 * clip's length plus a short margin. A 3-minute break is not cut at 60 s.
 */
export function introPlayMs(pcm: Buffer | null | undefined): number {
  if (!pcm?.length) return INTRO_MIN_MS;
  const clipMs = Math.ceil(pcmSeconds(pcm) * 1000);
  return Math.max(INTRO_MIN_MS, clipMs + INTRO_MARGIN_MS);
}

/**
 * When to open a song that was not already prefetched.
 * 0 means open now, which is every intro of about 30 s or less.
 * A longer intro opens `STREAM_LEAD_SEC` before it ends, so YouTube is not
 * left idle for the whole break.
 */
export function streamOpenDelayMs(introSec: number, prefetched: boolean): number {
  if (prefetched || !Number.isFinite(introSec) || introSec <= LONG_INTRO_SEC) return 0;
  return Math.max(0, Math.round((introSec - STREAM_LEAD_SEC) * 1000));
}
