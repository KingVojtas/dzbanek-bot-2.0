import { join } from 'node:path';
import { type Readable } from 'node:stream';
import youtubeDl from 'youtube-dl-exec';
import type { Track, TrackSource } from '../../core/types';
import { ytDlpCookieFlags } from '../ytdlp-cookies';

const YTDLP_CACHE = join(process.cwd(), 'data', 'yt-dlp-cache');

const PLAYLIST_CAP = 50;
const YOUTUBE_HOST = /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i;

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
  const url = info.webpage_url || info.original_url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : '');
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

export class YouTubeSource implements TrackSource {
  async resolve(input: string, requestedBy: string): Promise<Track[]> {
    const trimmed = input.trim();
    if (!trimmed) return [];

    const target = isYouTubeUrl(trimmed) ? trimmed : `ytsearch1:${trimmed}`;
    const isPlaylistUrl =
      isYouTubeUrl(trimmed) && /[?&]list=|\/playlist\?/i.test(trimmed) && !/[?&]v=/i.test(trimmed);

    const extra: Record<string, unknown> = { noPlaylist: !isPlaylistUrl };
    if (isPlaylistUrl) {
      extra.flatPlaylist = true;
      extra.playlistEnd = PLAYLIST_CAP;
    }
    const info = await dumpJson(target, extra);

    if (info._type === 'playlist' && Array.isArray(info.entries)) {
      const tracks: Track[] = [];
      for (const entry of info.entries.slice(0, PLAYLIST_CAP)) {
        if (!entry) continue;
        const track = toTrack(entry, requestedBy);
        if (track) tracks.push(track);
      }
      return tracks;
    }

    const track = toTrack(info, requestedBy);
    return track ? [track] : [];
  }

  /**
   * Search YouTube for a single best match. Used by the Spotify resolver
   * (`"Artist - Title"` queries) without treating the query as a URL.
   */
  async searchOne(query: string, requestedBy: string, extras?: Partial<Track>): Promise<Track | null> {
    const info = await dumpJson(`ytsearch1:${query}`, { noPlaylist: true });
    const video = info._type === 'playlist' ? (info.entries?.[0] ?? null) : info;
    if (!video) return null;
    return toTrack(video, requestedBy, extras);
  }

  async stream(track: Track): Promise<Readable> {
    const subprocess = youtubeDl.exec(
      track.url,
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

    // youtube-dl-exec's ChildProcess is also a Promise that rejects on non-zero
    // exit — swallow that so it becomes a stream error instead of a crash.
    void Promise.resolve(subprocess).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!stdout.destroyed) {
        stdout.destroy(err instanceof Error ? err : new Error(message));
      }
    });

    const kill = () => {
      try {
        subprocess.kill();
      } catch {
        /* already dead */
      }
    };
    stdout.once('close', kill);
    stdout.once('error', kill);

    return stdout;
  }
}

export { isYouTubeUrl };
