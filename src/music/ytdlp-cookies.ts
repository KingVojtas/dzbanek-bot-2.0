import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/logger';

const COOKIES_PATH = join(process.cwd(), 'data', 'yt-cookies.txt');
/** Gitignored; travels with /update-dzbanek uploads, so no server `.env` change is needed. */
const BUNDLED_PATH = join(process.cwd(), 'secrets', 'yt-cookies.txt');

let cookiesReady = false;

/** `YTDLP_COOKIES_BASE64` first, then the bundled file; null when neither is there. */
function cookieSource(): { cookies: Buffer; from: string } | null {
  const b64 = process.env.YTDLP_COOKIES_BASE64?.trim();
  if (b64) return { cookies: Buffer.from(b64, 'base64'), from: 'YTDLP_COOKIES_BASE64' };
  if (existsSync(BUNDLED_PATH)) {
    return { cookies: readFileSync(BUNDLED_PATH), from: 'secrets/yt-cookies.txt' };
  }
  return null;
}

/**
 * Write the Netscape cookies.txt into data/, where yt-dlp may rewrite it.
 * Returns where they came from, or null when there are none.
 */
function writeCookies(): string | null {
  const source = cookieSource();
  if (!source) return null;
  mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  writeFileSync(COOKIES_PATH, source.cookies);
  cookiesReady = true;
  return source.from;
}

/** Set up yt-dlp's cookies at startup. No-op when there are none. */
export function ensureYtDlpCookies(logger: Logger): void {
  if (cookiesReady) return;
  try {
    const from = writeCookies();
    if (from) logger.info(`yt-dlp cookies from ${from} written to data/yt-cookies.txt`);
    else logger.warn('No YouTube cookies: songs stop whenever YouTube asks for a sign-in.');
  } catch (error) {
    logger.warn('Failed to write yt-dlp cookies file:', error);
  }
}

/** Flags to spread into youtube-dl-exec option objects. */
export function ytDlpCookieFlags(): Record<string, string> {
  if (!cookiesReady) {
    try {
      writeCookies();
    } catch {
      return {};
    }
  }
  return cookiesReady ? { cookies: COOKIES_PATH } : {};
}

/** yt-dlp's bot-check or age-gate refusal, which only a signed-in session gets past. */
export function isBotCheck(errMsg: string): boolean {
  return /sign in to confirm|bot|cookies|age-restrict|confirm you’re not a bot|not a bot/i.test(
    errMsg,
  );
}

/** Hint shown to the user when yt-dlp reports a bot/age-gate block. */
export function youtubeBotCheckHint(errMsg: string): string | null {
  if (isBotCheck(errMsg)) {
    return (
      '❌ YouTube blocked this request (bot check / age gate).\n' +
      'YouTube now wants a signed-in session: export Netscape cookies from a ' +
      'logged-in browser and set `YTDLP_COOKIES_BASE64` in the server’s `.env`.'
    );
  }
  return null;
}
