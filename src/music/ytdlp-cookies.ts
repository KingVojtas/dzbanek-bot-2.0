import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/logger';

const DATA_DIR = join(process.cwd(), 'data');
const COOKIES_NAME = 'yt-cookies.txt';
const COOKIES_PATH = join(DATA_DIR, COOKIES_NAME);
/** sha256 of the export that data/yt-cookies.txt came from. */
const SOURCE_NAME = 'yt-cookies.source';
/** Gitignored; travels with /update-dzbanek uploads, so no server `.env` change is needed. */
const BUNDLED_PATH = join(process.cwd(), 'secrets', 'yt-cookies.txt');
/** First line of every cookies.txt that yt-dlp reads or writes. */
const NETSCAPE_HEADER = /^# (Netscape )?HTTP Cookie File/;

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

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Put the export where yt-dlp reads it. yt-dlp saves the cookies YouTube
 * refreshes back into that copy, so a copy of this same export is kept: a
 * restart must not undo the refreshes. A new export, or a copy that is
 * missing or damaged, is written over.
 */
export function placeCookies(cookies: Buffer, dir: string = DATA_DIR): 'written' | 'kept' {
  const file = join(dir, COOKIES_NAME);
  const marker = join(dir, SOURCE_NAME);
  const hash = createHash('sha256').update(cookies).digest('hex');
  if (readText(marker) === hash && NETSCAPE_HEADER.test(readText(file) ?? '')) return 'kept';
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, cookies);
  writeFileSync(marker, hash);
  return 'written';
}

/** Where the cookies came from and what became of data/; null when there are none. */
function writeCookies(): string | null {
  const source = cookieSource();
  if (!source) return null;
  const placed = placeCookies(source.cookies);
  cookiesReady = true;
  return placed === 'kept'
    ? `${source.from} (kept the copy yt-dlp refreshed)`
    : `${source.from} written to data/yt-cookies.txt`;
}

/** Set up yt-dlp's cookies at startup. No-op when there are none. */
export function ensureYtDlpCookies(logger: Logger): void {
  if (cookiesReady) return;
  try {
    const from = writeCookies();
    if (from) logger.info(`yt-dlp cookies from ${from}`);
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
      '❌ YouTube refused this song (bot check or age gate).\n' +
      'If every song fails, the bot’s YouTube sign-in has run out, and its owner gets a DM to renew it.'
    );
  }
  return null;
}
