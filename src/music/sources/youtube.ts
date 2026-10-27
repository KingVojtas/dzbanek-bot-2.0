import { join } from 'node:path';
import { Transform, type PassThrough, type Readable } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import type { Track, TrackSource } from '../../core/types';
import { bufferStream } from '../buffer-stream';
import { logger } from '../../core/logger';
import { isBotCheck, ytDlpCookieFlags } from '../ytdlp-cookies';
import {
  DEFAULT_YOUTUBE_CLIENTS,
  playerClientArg,
  resolveYouTubeClients,
  shouldWarnFallback,
  type ClientTiming,
} from '../youtube-clients';
import { findSoundCloudStandIn } from './soundcloud';

const YTDLP_CACHE = join(process.cwd(), 'data', 'yt-dlp-cache');

const PLAYLIST_CAP = 50;
const YOUTUBE_HOST = /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i;
/** Resolved metadata stays useful for hours; stream URLs are fetched fresh anyway. */
const RESOLVE_CACHE_MAX = 200;
const RESOLVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** A warm stream nobody claims is killed after this. */
const WARM_TTL_MS = 30_000;
/** "Me at the zoo": 19 s, never age-gated. The health check's test song. */
export const PROBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
/** A normal music video, timed beside the health-check song. */
export const CLIENT_BENCHMARK_SONG = 'https://www.youtube.com/watch?v=o_2t4TrXPvs';
export const CLIENT_BENCHMARK_URLS = [PROBE_URL, CLIENT_BENCHMARK_SONG] as const;

/** `watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/` → the 11-char id. */
export function youTubeVideoId(input: string): string | null {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
    if (!YOUTUBE_HOST.test(url.hostname)) return null;
    if (/(^|\.)youtu\.be$/i.test(url.hostname)) return url.pathname.split('/')[1] || null;
    const v = url.searchParams.get('v');
    if (v) return v;
    return url.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{6,})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface YtDlpJson {
  id?: string;
  title?: string;
  webpage_url?: string;
  original_url?: string;
  url?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: { url?: string }[];
  channel?: string;
  uploader?: string;
  artist?: string;
  view_count?: number;
  upload_date?: string;
  _type?: string;
  entries?: (YtDlpJson | null)[];
}

function isYouTubeUrl(input: string): boolean {
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
    return YOUTUBE_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

function baseFlags(): Record<string, unknown> {
  return {
    noWarnings: true,
    noCheckCertificates: true,
    restrictFilenames: true,
    geoBypass: true,
    cacheDir: YTDLP_CACHE,
    ...ytDlpCookieFlags(),
  };
}

/** Metadata/search: cookie-free clients that still return titles without nsig. */
function resolveFlags(): Record<string, unknown> {
  return {
    ...baseFlags(),
    ignoreNoFormatsError: true,
    noCheckFormats: true,
    extractorArgs: 'youtube:player_client=android_vr,tv_simply,mweb,web_embedded',
  };
}

/**
 * Streaming flags. `clients` is the player_client list; blank uses today's.
 * Null omits player_client so yt-dlp uses its own default.
 */
function streamFlags(clients?: string | null): Record<string, unknown> {
  const flags: Record<string, unknown> = {
    ...baseFlags(),
    jsRuntimes: 'deno',
    remoteComponents: 'ejs:github',
  };
  const extractorArgs = playerClientArg(clients);
  if (extractorArgs == null) return flags;
  return { ...flags, extractorArgs };
}

/** yt-dlp's own `ERROR:` line (e.g. YouTube's bot check) rather than "exit code 1". */
function ytDlpError(stderr: string, fallback: string): Error {
  const line = stderr
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('ERROR:'));
  return new Error(line ? line.replace(/^ERROR:\s*/, '') : fallback);
}

interface SpawnedStream {
  audio: Readable;
  /** Resolves on the first audio bytes; rejects with yt-dlp's error if none come. */
  ready: Promise<void>;
  /** Video id yt-dlp prints before it downloads, when asked. Null if it never says. */
  videoId: Promise<string | null>;
}

/** `clients` null omits player_client. */
type OpenAudio = (url: string, printId: boolean, clients: string | null) => SpawnedStream;

function pickThumbnail(info: YtDlpJson): string | undefined {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = info.thumbnails?.filter((t) => t.url);
  return thumbs?.[thumbs.length - 1]?.url;
}

function formatUploadDate(raw?: string): string | undefined {
  if (!raw || !/^\d{8}$/.test(raw)) return raw || undefined;
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function toTrack(info: YtDlpJson, requestedBy: string, extras?: Partial<Track>): Track | null {
  const url =
    info.webpage_url ||
    info.original_url ||
    (info.id ? `https://www.youtube.com/watch?v=${info.id}` : '');
  const title = info.title?.trim();
  if (!url || !title) return null;

  return {
    title,
    url,
    durationSec: typeof info.duration === 'number' && info.duration > 0 ? info.duration : 0,
    thumbnail: pickThumbnail(info),
    requestedBy,
    uploader: info.artist || info.channel || info.uploader,
    views: typeof info.view_count === 'number' ? info.view_count : undefined,
    uploadedAt: formatUploadDate(info.upload_date),
    source: extras?.source ?? 'youtube',
    sourceUrl: extras?.sourceUrl,
  };
}

async function dumpJson(target: string, extra: Record<string, unknown> = {}): Promise<YtDlpJson> {
  const run = async (flags: Record<string, unknown>) => {
    const raw = await youtubeDl(target, {
      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: extra.noPlaylist ?? true,
      ...flags,
      ...extra,
    } as Parameters<typeof youtubeDl>[1]);
    return typeof raw === 'string' ? (JSON.parse(raw) as YtDlpJson) : (raw as YtDlpJson);
  };

  try {
    return await run(resolveFlags());
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/format is not available|no video formats/i.test(msg)) throw error;
    return run(streamFlags());
  }
}

/**
 * A search hit without extracting the video: 2 s instead of 6 s, and the
 * entry still carries title, id, duration, channel, views, and thumbnails.
 * Falls back to a full extraction when the flat list has nothing usable.
 */
async function searchFirst(query: string): Promise<YtDlpJson | null> {
  const started = Date.now();
  try {
    try {
      const raw = await youtubeDl(`ytsearch1:${query}`, {
        dumpSingleJson: true,
        flatPlaylist: true,
        ...baseFlags(),
      } as Parameters<typeof youtubeDl>[1]);
      const info = typeof raw === 'string' ? (JSON.parse(raw) as YtDlpJson) : (raw as YtDlpJson);
      const hit = info.entries?.find((entry) => entry?.title && entry.id);
      if (hit) return hit;
    } catch {
      /* fall through to the full search */
    }
    const info = await dumpJson(`ytsearch1:${query}`, { noPlaylist: true });
    return info._type === 'playlist' ? (info.entries?.[0] ?? null) : info;
  } finally {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    logger.info(`YouTube search: ${seconds} s for "${query}"`);
  }
}

/** Only what toTrack reads, so the cache does not hold format lists. */
function slim(info: YtDlpJson): YtDlpJson {
  return {
    id: info.id,
    title: info.title,
    webpage_url: info.webpage_url,
    original_url: info.original_url,
    duration: info.duration,
    thumbnail: pickThumbnail(info),
    channel: info.channel,
    uploader: info.uploader,
    artist: info.artist,
    view_count: info.view_count,
    upload_date: info.upload_date,
  };
}

export class YouTubeSource implements TrackSource {
  /** Player clients for new streams. Today's list when the setting is blank. */
  private readonly clients: string;
  private readonly openAudio: OpenAudio;
  private readonly warn: (message: string) => void;
  /** Last time the hourly fallback warning was logged. */
  private lastFallbackWarn = -Infinity;

  /** Query or URL → slim metadata, oldest first (Map keeps insertion order). */
  private readonly resolved = new Map<string, { at: number; entries: YtDlpJson[] }>();
  private readonly warmed = new Map<string, WarmEntry>();
  /** A `ytsearch1:` download started while the flat search runs, keyed by the query. */
  private readonly searchWarm = new Map<string, WarmEntry>();

  /** Told when YouTube streams a song (true) or refuses with a bot check (false). */
  onYouTube: ((ok: boolean) => void) | null = null;

  constructor(clients?: string | null, openAudio?: OpenAudio, warn?: (message: string) => void) {
    this.clients = resolveYouTubeClients(clients);
    this.openAudio = openAudio ?? openYouTubeStream;
    this.warn = warn ?? ((message) => logger.warn(message));
  }

  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const trimmed = input.trim();
    if (!trimmed) return [];

    const entries = await this.cached(`resolve:${trimmed}`, async () => {
      if (!isYouTubeUrl(trimmed)) {
        const hit = await searchFirst(trimmed);
        return hit ? [hit] : [];
      }

      const isPlaylistUrl = /[?&]list=|\/playlist\?/i.test(trimmed) && !/[?&]v=/i.test(trimmed);
      const extra: Record<string, unknown> = { noPlaylist: !isPlaylistUrl };
      if (isPlaylistUrl) {
        extra.flatPlaylist = true;
        extra.playlistEnd = PLAYLIST_CAP;
      }
      const info = await dumpJson(trimmed, extra).catch((error: unknown) => {
        this.noticeBlock(error);
        throw error;
      });
      if (info._type === 'playlist' && Array.isArray(info.entries)) {
        return info.entries
          .slice(0, PLAYLIST_CAP)
          .filter((entry): entry is YtDlpJson => entry != null);
      }
      return [info];
    });

    if (!isYouTubeUrl(trimmed)) {
      const id = entries[0]?.id;
      if (id) this.bindSearchWarm(trimmed, id);
      else this.dropSearchWarm(trimmed);
    }
    return entries.flatMap((entry) => toTrack(entry, requestedBy) ?? []);
  }

  /**
   * Search YouTube for a single best match. Used by the Spotify resolver
   * (`"Artist - Title"` queries) without treating the query as a URL.
   */
  async searchOne(
    query: string,
    requestedBy: string,
    extras?: Partial<Track>,
  ): Promise<Track | null> {
    const [hit] = await this.cached(`search:${query}`, async () => {
      const found = await searchFirst(query);
      return found ? [found] : [];
    });
    if (hit?.id) this.bindSearchWarm(query, hit.id);
    else this.dropSearchWarm(query);
    return hit ? toTrack(hit, requestedBy, extras) : null;
  }

  /**
   * Start streaming `url` before its metadata is back, so /play pays for the
   * slower of the two instead of both. Unclaimed streams die after 30 s.
   */
  warm(url: string): void {
    const id = youTubeVideoId(url);
    if (!id || this.warmed.has(id)) return;
    const spawned = this.trySpawn(url);
    if (!spawned) return;
    const stream = bufferStream(spawned.audio);
    const entry = this.holdWarm(stream, spawned.ready, () => {
      if (this.warmed.get(id)?.stream === stream) this.warmed.delete(id);
    });
    this.warmed.set(id, entry);
  }

  /**
   * Start `ytsearch1:` audio while the flat search is still running.
   * Claimed later only if yt-dlp's id is the search hit's id.
   */
  warmSearch(query: string): void {
    const key = query.trim();
    if (!key || this.searchWarm.has(key)) return;
    const spawned = this.trySpawn(`ytsearch1:${key}`, true);
    if (!spawned) return;
    const stream = bufferStream(spawned.audio);
    const entry = this.holdWarm(stream, spawned.ready, () => {
      if (this.searchWarm.get(key)?.stream === stream) this.searchWarm.delete(key);
      for (const [warmId, warm] of this.warmed) {
        if (warm.stream === stream) this.warmed.delete(warmId);
      }
    });
    entry.expectId = spawned.videoId;
    this.searchWarm.set(key, entry);
  }

  /**
   * YouTube's audio, or the same song from SoundCloud when YouTube demands a
   * sign-in (bot check). Without a close SoundCloud match, YouTube's error stands.
   */
  async stream(track: Track): Promise<Readable> {
    try {
      const audio = await this.streamYouTube(track);
      this.onYouTube?.(true);
      return audio;
    } catch (error) {
      if (!this.noticeBlock(error)) throw error;
      const standIn = await findSoundCloudStandIn(track).catch(() => null);
      if (!standIn) throw error;
      logger.warn(`YouTube bot check on "${track.title}" — playing ${standIn} instead.`);
      const fallback = this.spawnStream(standIn, false, DEFAULT_YOUTUBE_CLIENTS);
      await fallback.ready;
      return fallback.audio;
    }
  }

  /**
   * Null when YouTube hands over a song's audio URL, as it does for /play,
   * else yt-dlp's reason. Nothing is downloaded.
   */
  async probe(): Promise<string | null> {
    try {
      await youtubeDl(PROBE_URL, {
        getUrl: true,
        format: 'bestaudio/best',
        noPlaylist: true,
        ...streamFlags(this.clients),
      } as Parameters<typeof youtubeDl>[1]);
      return null;
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr;
      return ytDlpError(
        typeof stderr === 'string' ? stderr : '',
        err instanceof Error ? err.message : String(err),
      ).message;
    }
  }

  /** A bot check is passed on to `onYouTube`; true when `error` was one. */
  private noticeBlock(error: unknown): boolean {
    if (!isBotCheck(error instanceof Error ? error.message : String(error))) return false;
    this.onYouTube?.(false);
    return true;
  }

  private async streamYouTube(track: Track): Promise<Readable> {
    const id = youTubeVideoId(track.url);
    const warm = id ? this.takeWarm(id) : undefined;
    if (warm && !warm.stream.destroyed) {
      const printed = warm.expectId ? await warm.expectId : id;
      if (printed === id) {
        // A failed warm download errors the buffer. Hold that until `ready` rejects,
        // or it escapes as an uncaught error before the fallback can run.
        const ignoreError = () => {};
        warm.stream.once('error', ignoreError);
        try {
          // A bot check rejects ready and still reaches stream(), which tries SoundCloud.
          await warm.ready;
          warm.stream.removeListener('error', ignoreError);
          if (!warm.stream.destroyed) return warm.stream;
        } catch (error) {
          warm.stream.removeListener('error', ignoreError);
          if (!warm.stream.destroyed) warm.stream.destroy();
          return this.retryOrThrow(track, error);
        }
      } else {
        warm.stream.destroy();
      }
    }
    try {
      return await this.playFresh(track.url);
    } catch (error) {
      return this.retryOrThrow(track, error);
    }
  }

  /**
   * The configured list failed. One retry with today's list, unless this
   * already is that list or YouTube asked for a sign-in.
   */
  private async retryOrThrow(track: Track, error: unknown): Promise<Readable> {
    const message = error instanceof Error ? error.message : String(error);
    if (this.clients === DEFAULT_YOUTUBE_CLIENTS || isBotCheck(message)) {
      throw error instanceof Error ? error : new Error(message);
    }
    this.noteFallback(track.title);
    return this.playFresh(track.url, DEFAULT_YOUTUBE_CLIENTS);
  }

  private noteFallback(title: string): void {
    const now = Date.now();
    if (!shouldWarnFallback(this.lastFallbackWarn, now)) return;
    this.lastFallbackWarn = now;
    this.warn(`YouTube clients "${this.clients}" failed for "${title}"; used the default list.`);
  }

  private async playFresh(url: string, clients?: string): Promise<Readable> {
    const spawned = this.spawnStream(url, false, clients);
    await spawned.ready;
    return spawned.audio;
  }

  /** Move a search download onto its video id, or drop it when the search missed. */
  private bindSearchWarm(query: string, id: string): void {
    const warm = this.searchWarm.get(query.trim());
    if (!warm) return;
    this.searchWarm.delete(query.trim());
    if (this.warmed.has(id)) {
      clearTimeout(warm.timer);
      warm.stream.destroy();
      return;
    }
    this.warmed.set(id, warm);
  }

  private dropSearchWarm(query: string): void {
    const warm = this.searchWarm.get(query.trim());
    if (!warm) return;
    this.searchWarm.delete(query.trim());
    clearTimeout(warm.timer);
    warm.stream.destroy();
  }

  private takeWarm(id: string): WarmEntry | undefined {
    const warm = this.warmed.get(id);
    if (!warm) return undefined;
    this.warmed.delete(id);
    clearTimeout(warm.timer);
    return warm;
  }

  private trySpawn(url: string, printId = false): SpawnedStream | null {
    try {
      return this.spawnStream(url, printId);
    } catch {
      return null;
    }
  }

  /** Kill the download if nobody claims it within 30 s. `forget` drops it from its map. */
  private holdWarm(stream: PassThrough, ready: Promise<void>, forget: () => void): WarmEntry {
    const timer = setTimeout(() => {
      forget();
      stream.destroy();
    }, WARM_TTL_MS);
    timer.unref?.();
    stream.once('close', forget);
    return { stream, ready, timer };
  }

  private async cached(key: string, load: () => Promise<YtDlpJson[]>): Promise<YtDlpJson[]> {
    const hit = this.resolved.get(key);
    if (hit && Date.now() - hit.at < RESOLVE_CACHE_TTL_MS) return hit.entries;
    const entries = (await load()).map(slim);
    // Only a real answer is remembered; an empty search may work next time.
    if (entries.length > 0) {
      this.resolved.delete(key);
      this.resolved.set(key, { at: Date.now(), entries });
      while (this.resolved.size > RESOLVE_CACHE_MAX) {
        const oldest = this.resolved.keys().next().value;
        if (oldest === undefined) break;
        this.resolved.delete(oldest);
      }
    }
    return entries;
  }

  /**
   * yt-dlp's audio on a stream. `clients` defaults to the configured list;
   * null omits player_client. When YouTube refuses (bot check), stdout just
   * ends empty, so `ready` waits for real bytes and otherwise carries the error.
   */
  private spawnStream(url: string, printId = false, clients?: string | null): SpawnedStream {
    return this.openAudio(url, printId, clients === undefined ? this.clients : clients);
  }
}

/**
 * Time until the first audio bytes, then destroy the stream.
 * Its close handler kills yt-dlp. Null `clients` omits player_client.
 */
export async function timeYouTubeClient(
  url: string,
  clients: string | null,
  open: OpenAudio = openYouTubeStream,
): Promise<ClientTiming> {
  const started = Date.now();
  let opened: SpawnedStream | undefined;
  try {
    opened = open(url, false, clients);
    await opened.ready;
    return { ok: true, seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return {
      ok: false,
      seconds: (Date.now() - started) / 1000,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (opened && !opened.audio.destroyed) opened.audio.destroy();
  }
}

/**
 * yt-dlp's audio on a stream. When YouTube refuses (bot check), stdout just
 * ends empty, so `ready` waits for real bytes and otherwise carries the error.
 */
function openYouTubeStream(url: string, printId: boolean, clients: string | null): SpawnedStream {
  const subprocess = youtubeDl.exec(
    url,
    {
      output: '-',
      format: 'bestaudio/best',
      noPlaylist: true,
      quiet: true,
      // The id is printed on stderr. Audio stays on stdout (`-o -`).
      ...(printId ? { print: 'before_dl:%(id)s', noSimulate: true } : {}),
      ...streamFlags(clients),
    } as Parameters<typeof youtubeDl.exec>[1],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const stdout = subprocess.stdout;
  if (!stdout) {
    throw new Error('yt-dlp produced no audio stream.');
  }

  let started = (): void => {};
  let failed = (_error: Error): void => {};
  const ready = new Promise<void>((resolve, reject) => {
    started = resolve;
    failed = reject;
  });
  // A warm stream nobody claims has nobody awaiting it.
  ready.catch(() => {});

  // Passes audio through untouched; the first chunk marks the stream as live.
  const audio = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      started();
      done(null, chunk);
    },
  });
  stdout.pipe(audio);

  // youtube-dl-exec's ChildProcess is also a Promise that rejects on non-zero
  // exit — swallow that so it becomes a stream error instead of a crash. Its
  // error carries yt-dlp's stderr as a string.
  Promise.resolve(subprocess).then(
    () => failed(new Error('yt-dlp produced no audio.')),
    (err: unknown) => {
      const stderr = (err as { stderr?: unknown }).stderr;
      const error = ytDlpError(
        typeof stderr === 'string' ? stderr : '',
        err instanceof Error ? err.message : String(err),
      );
      failed(error);
      if (!audio.destroyed) audio.destroy(error);
    },
  );

  // Destroying the audio (skip, shuffle) must also end yt-dlp.
  const kill = () => {
    try {
      subprocess.kill();
    } catch {
      /* already dead */
    }
    if (!stdout.destroyed) stdout.destroy();
  };
  audio.once('close', kill);
  audio.once('error', kill);

  const videoId = printId ? printedVideoId(subprocess.stderr, ready) : Promise.resolve(null);
  // Drain stderr so a full pipe cannot stall yt-dlp. The id listener is already on.
  subprocess.stderr?.resume();

  return { audio, ready, videoId };
}

interface WarmEntry {
  stream: PassThrough;
  ready: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  expectId?: Promise<string | null>;
}

/**
 * The id yt-dlp prints on stderr (`before_dl:%(id)s`). It arrives before the
 * audio. Null when the line never comes, including once audio has started
 * without one, so a search download is not held open to guess.
 */
function printedVideoId(
  stderr: Readable | null,
  audioReady: Promise<void>,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!stderr) {
      resolve(null);
      return;
    }
    let buf = '';
    let settled = false;
    const finish = (id: string | null) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };
    const take = (text: string) => {
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const id = line.trim();
        if (/^[\w-]{6,}$/.test(id)) finish(id);
      }
    };
    stderr.on('data', (chunk: Buffer | string) => {
      take(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    stderr.on('end', () => {
      const id = buf.trim();
      finish(/^[\w-]{6,}$/.test(id) ? id : null);
    });
    void audioReady.then(
      () => {
        const timer = setTimeout(() => {
          const id = buf.trim();
          finish(/^[\w-]{6,}$/.test(id) ? id : null);
        }, 500);
        timer.unref?.();
      },
      () => finish(null),
    );
  });
}

export { isYouTubeUrl };
