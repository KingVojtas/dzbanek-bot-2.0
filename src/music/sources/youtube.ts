import { join } from 'node:path';
import { Transform, type PassThrough, type Readable } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import type { Track, TrackSource } from '../../core/types';
import { bufferStream } from '../buffer-stream';
import { logger } from '../../core/logger';
import { isBotCheck, ytDlpCookieFlags } from '../ytdlp-cookies';
import { findSoundCloudStandIn } from './soundcloud';

const YTDLP_CACHE = join(process.cwd(), 'data', 'yt-dlp-cache');

const PLAYLIST_CAP = 50;
const YOUTUBE_HOST = /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i;
/** Resolved metadata stays useful for hours; stream URLs are fetched fresh anyway. */
const RESOLVE_CACHE_MAX = 200;
const RESOLVE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** A warm stream nobody claims is killed after this. */
const WARM_TTL_MS = 30_000;

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

/** Streaming: Deno + several clients so at least one format list is usable. */
function streamFlags(): Record<string, unknown> {
  return {
    ...baseFlags(),
    jsRuntimes: 'deno',
    remoteComponents: 'ejs:github',
    extractorArgs: 'youtube:player_client=android_vr,tv_simply,mweb,web,web_embedded',
  };
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
}

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
  /** Query or URL → slim metadata, oldest first (Map keeps insertion order). */
  private readonly resolved = new Map<string, { at: number; entries: YtDlpJson[] }>();
  private readonly warmed = new Map<
    string,
    { stream: PassThrough; ready: Promise<void>; timer: ReturnType<typeof setTimeout> }
  >();

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
      const info = await dumpJson(trimmed, extra);
      if (info._type === 'playlist' && Array.isArray(info.entries)) {
        return info.entries
          .slice(0, PLAYLIST_CAP)
          .filter((entry): entry is YtDlpJson => entry != null);
      }
      return [info];
    });

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
    return hit ? toTrack(hit, requestedBy, extras) : null;
  }

  /**
   * Start streaming `url` before its metadata is back, so /play pays for the
   * slower of the two instead of both. Unclaimed streams die after 30 s.
   */
  warm(url: string): void {
    const id = youTubeVideoId(url);
    if (!id || this.warmed.has(id)) return;
    let spawned: SpawnedStream;
    try {
      spawned = this.spawnStream(url);
    } catch {
      return;
    }
    const stream = bufferStream(spawned.audio);
    const timer = setTimeout(() => {
      if (this.warmed.get(id)?.stream !== stream) return;
      this.warmed.delete(id);
      stream.destroy();
    }, WARM_TTL_MS);
    timer.unref?.();
    stream.once('close', () => {
      if (this.warmed.get(id)?.stream === stream) this.warmed.delete(id);
    });
    this.warmed.set(id, { stream, ready: spawned.ready, timer });
  }

  /**
   * YouTube's audio, or the same song from SoundCloud when YouTube demands a
   * sign-in (bot check). Without a close SoundCloud match, YouTube's error stands.
   */
  async stream(track: Track): Promise<Readable> {
    try {
      return await this.streamYouTube(track);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!isBotCheck(msg)) throw error;
      const standIn = await findSoundCloudStandIn(track).catch(() => null);
      if (!standIn) throw error;
      logger.warn(`YouTube bot check on "${track.title}" — playing ${standIn} instead.`);
      const fallback = this.spawnStream(standIn);
      await fallback.ready;
      return fallback.audio;
    }
  }

  private async streamYouTube(track: Track): Promise<Readable> {
    const id = youTubeVideoId(track.url);
    const warm = id ? this.warmed.get(id) : undefined;
    if (id && warm) {
      this.warmed.delete(id);
      clearTimeout(warm.timer);
      if (!warm.stream.destroyed) {
        await warm.ready;
        return warm.stream;
      }
    }
    const fresh = this.spawnStream(track.url);
    await fresh.ready;
    return fresh.audio;
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
   * yt-dlp's audio on a stream. When YouTube refuses (bot check), stdout just
   * ends empty, so `ready` waits for real bytes and otherwise carries the error.
   */
  private spawnStream(url: string): SpawnedStream {
    const subprocess = youtubeDl.exec(
      url,
      {
        output: '-',
        format: 'bestaudio/best',
        noPlaylist: true,
        quiet: true,
        ...streamFlags(),
      } as Parameters<typeof youtubeDl.exec>[1],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const stdout = subprocess.stdout;
    if (!stdout) {
      throw new Error('yt-dlp produced no audio stream.');
    }

    // Drain stderr so a full pipe cannot stall yt-dlp.
    subprocess.stderr?.resume();

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

    return { audio, ready };
  }
}

export { isYouTubeUrl };
