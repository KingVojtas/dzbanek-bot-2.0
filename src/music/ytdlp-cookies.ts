import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/logger';

const COOKIES_PATH = join(process.cwd(), 'data', 'yt-cookies.txt');

let cookiesReady = false;

/**
 * Decode `YTDLP_COOKIES_BASE64` (Netscape cookies.txt) into a local file
 * that yt-dlp can read. No-op when the env var is unset.
 */
export function ensureYtDlpCookies(logger: Logger): void {
  if (cookiesReady) return;
  const b64 = process.env.YTDLP_COOKIES_BASE64?.trim();
  if (!b64) return;

  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(COOKIES_PATH, Buffer.from(b64, 'base64'));
    cookiesReady = true;
    logger.info('yt-dlp cookies written to data/yt-cookies.txt');
  } catch (error) {
    logger.warn('Failed to write yt-dlp cookies file:', error);
  }
}

/** Flags to spread into youtube-dl-exec option objects. */
export function ytDlpCookieFlags(): Record<string, string> {
  if (!cookiesReady && process.env.YTDLP_COOKIES_BASE64?.trim()) {
    try {
      mkdirSync(join(process.cwd(), 'data'), { recursive: true });
      writeFileSync(COOKIES_PATH, Buffer.from(process.env.YTDLP_COOKIES_BASE64, 'base64'));
      cookiesReady = true;
    } catch {
      return {};
    }
  }
  return cookiesReady ? { cookies: COOKIES_PATH } : {};
}

/** Hint shown to the user when yt-dlp reports a bot/age-gate block. */
export function youtubeBotCheckHint(errMsg: string): string | null {
  if (/sign in to confirm|bot|cookies|age-restrict|confirm you’re not a bot|not a bot/i.test(errMsg)) {
    return (
      '❌ YouTube blocked this request (bot check / age gate).\n' +
      'On a home PC this usually works. If it keeps failing, export Netscape cookies ' +
      'from a logged-in browser and set `YTDLP_COOKIES_BASE64` in `.env`.'
    );
  }
  return null;
}
