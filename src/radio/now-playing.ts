import type { Logger } from '../core/logger';
import type { RadioStation } from './station';

export interface NowPlayingTrack {
  artist: string | null;
  title: string;
  coverUrl?: string;
}

const ICY_TIMEOUT_MS = 8_000;
const API_TIMEOUT_MS = 8_000;

export function trackKey(track: NowPlayingTrack | null): string {
  if (!track) return '';
  return `${(track.artist ?? '').trim().toLowerCase()}|${track.title.trim().toLowerCase()}`;
}

export function formatTrackLine(track: NowPlayingTrack): string {
  if (track.artist) return `**${track.title}**\n${track.artist}`;
  return `**${track.title}**`;
}

/**
 * Station now-playing, independent of the voice FFmpeg process.
 * Prefers the radia.cz JSON API, then a short ICY StreamTitle read.
 */
export async function fetchNowPlaying(
  station: RadioStation,
  logger: Logger,
): Promise<NowPlayingTrack | null> {
  if (station.nowPlayingSnippetUrl) {
    const fromSite = await fetchBroadcastSnippet(station, logger);
    if (fromSite) return fromSite;
  }

  if (station.nowPlayingUrl) {
    const fromApi = await fetchRadiaNow(station.nowPlayingUrl, logger);
    if (fromApi && isFresh(fromApi.endedAt, fromApi.startedAt)) {
      return { artist: fromApi.artist, title: fromApi.title, coverUrl: fromApi.coverUrl };
    }
  }

  const icy = await fetchIcyTitle(station.streamUrl, logger);
  if (!icy || isGenericTitle(icy, station)) return null;
  return splitIcyTitle(icy);
}

interface RadiaSong {
  artist: string | null;
  title: string;
  coverUrl?: string;
  startedAt?: string;
  endedAt?: string;
}

async function fetchBroadcastSnippet(
  station: RadioStation,
  logger: Logger,
): Promise<NowPlayingTrack | null> {
  const url = station.nowPlayingSnippetUrl;
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'dzbanek-bot/2.0',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: station.websiteUrl,
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { snippets?: Record<string, string> };
    const html = data.snippets?.['snippet-broadcast-info'];
    if (!html) return null;

    const name = decodeHtml(html.match(/id="interpeteur-name">([^<]+)/i)?.[1] ?? '');
    const desc = decodeHtml(html.match(/now-playing__broadcast">\s*([^<]+)/i)?.[1] ?? '');
    if (!name || isGenericTitle(name, station)) return null;

    if (name.includes(' - ')) return splitIcyTitle(name);

    if (desc && desc.length < 80 && !/[.!?…]['"”)]?$/.test(desc) && !isGenericTitle(desc, station)) {
      return { artist: name, title: desc };
    }

    return { artist: station.name, title: name };
  } catch (error) {
    logger.debug(`Now-playing snippet failed (${url}):`, error);
    return null;
  }
}

async function fetchRadiaNow(url: string, logger: Logger): Promise<RadiaSong | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'dzbanek-bot/2.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const title = str(data.song) ?? str(data.title);
    if (!title) return null;
    const artist = str(data.interpret) ?? str(data.artist);
    const cover = str(data.image);
    return {
      artist,
      title,
      coverUrl: cover && /^https?:\/\//i.test(cover) ? cover : undefined,
      startedAt: str(data.beginAt) ?? undefined,
      endedAt: str(data.endAt) ?? undefined,
    };
  } catch (error) {
    logger.debug(`Now-playing API failed (${url}):`, error);
    return null;
  }
}

async function fetchIcyTitle(streamUrl: string, logger: Logger): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ICY_TIMEOUT_MS);
  try {
    const res = await fetch(streamUrl, {
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'WinampMPEG/5.0' },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return null;
    const metaint = Number(res.headers.get('icy-metaint') ?? 0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    const need = metaint > 0 ? metaint + 256 : 32_768;
    while (got < need) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (metaint <= 0 || buf.length <= metaint) return null;
    const metaLen = buf[metaint]! * 16;
    const meta = buf.subarray(metaint + 1, metaint + 1 + metaLen).toString('latin1');
    const match = /StreamTitle='([^']*)'/.exec(meta);
    const title = (match?.[1] ?? '').trim();
    return title || null;
  } catch (error) {
    logger.debug(`ICY now-playing failed (${streamUrl}):`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function splitIcyTitle(raw: string): NowPlayingTrack {
  const parts = raw.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const artist = parts[0]!.trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { artist, title };
  }
  return { artist: null, title: raw.trim() };
}

function isGenericTitle(raw: string, station: RadioStation): boolean {
  const n = normalize(raw);
  if (!n) return true;
  const stationName = normalize(station.name);
  if (n === stationName || n === normalize(station.choiceName)) return true;
  if (n.startsWith(stationName) && n.length < stationName.length + 24) return true;
  if (/radio\s*beat/.test(n) && /classic\s*rock/.test(n)) return true;
  if (/^radio\s*kiss$/.test(n)) return true;
  return false;
}

function isFresh(endedAt?: string, startedAt?: string): boolean {
  const now = Date.now();
  if (endedAt) {
    const end = Date.parse(endedAt);
    if (!Number.isNaN(end)) return end + 120_000 >= now;
  }
  if (startedAt) {
    const start = Date.parse(startedAt);
    if (!Number.isNaN(start)) return now - start < 20 * 60_000;
  }
  return true;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
