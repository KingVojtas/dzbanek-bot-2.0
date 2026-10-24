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
 * Prefers the station's own feed (radia.cz JSON or Triton), then a short ICY StreamTitle read.
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

  if (station.tritonMount) {
    const fromTriton = await fetchTritonNow(station.tritonMount, logger);
    if (fromTriton && !isGenericTitle(fromTriton.title, station)) return fromTriton;
  }

  const icy = await fetchIcyMeta(station.streamUrl, logger);
  if (!icy || isGenericTitle(icy.title, station)) return null;
  const track = splitIcyTitle(icy.title);
  const cover = icyCover(icy.streamUrl);
  return cover ? { ...track, coverUrl: cover } : track;
}

/** Triton's latest track on `mount`, or null when the feed is empty or stale. */
async function fetchTritonNow(mount: string, logger: Logger): Promise<NowPlayingTrack | null> {
  const url =
    'https://np.tritondigital.com/public/nowplaying' +
    `?mountName=${encodeURIComponent(mount)}&numberToFetch=1&eventType=track`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dzbanek-bot/2.0' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseTritonNow(await res.text());
  } catch (error) {
    logger.debug(`Triton now-playing failed (${mount}):`, error);
    return null;
  }
}

/** Reads Triton's `<nowplaying-info>` XML. Stale after 20 minutes, like radia.cz. */
export function parseTritonNow(xml: string, now = Date.now()): NowPlayingTrack | null {
  // Newest first: only the first record matters.
  const info = /<nowplaying-info\b[^>]*>([\s\S]*?)<\/nowplaying-info>/.exec(xml)?.[1];
  if (!info) return null;
  const props = new Map<string, string>();
  for (const m of info.matchAll(
    /<property name="([^"]+)">(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/property>/g,
  )) {
    props.set(m[1]!, decodeHtml(m[2] ?? m[3] ?? ''));
  }
  const title = str(props.get('cue_title'));
  if (!title) return null;
  const startMs = Number(props.get('cue_time_start'));
  if (Number.isFinite(startMs) && startMs > 0 && now - startMs > 20 * 60_000) return null;
  return { artist: str(props.get('track_artist_name')), title };
}

/** Radio Paradise puts the album cover in StreamUrl. Only an image URL counts. */
export function icyCover(streamUrl: string | null): string | undefined {
  if (!streamUrl || !/^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(streamUrl)) {
    return undefined;
  }
  return streamUrl.replace(/^http:\/\//i, 'https://');
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

    if (
      desc &&
      desc.length < 80 &&
      !/[.!?…]['"”)]?$/.test(desc) &&
      !isGenericTitle(desc, station)
    ) {
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

async function fetchIcyMeta(
  streamUrl: string,
  logger: Logger,
): Promise<{ title: string; streamUrl: string | null } | null> {
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
    const meta = decodeIcyBytes(buf.subarray(metaint + 1, metaint + 1 + metaLen));
    return parseIcyMeta(meta);
  } catch (error) {
    logger.debug(`ICY now-playing failed (${streamUrl}):`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** StreamTitle and StreamUrl from one ICY metadata block. Null without a title. */
export function parseIcyMeta(meta: string): { title: string; streamUrl: string | null } | null {
  const title = (/StreamTitle='(.*?)';/.exec(meta)?.[1] ?? '').trim();
  if (!title) return null;
  const streamUrl = (/StreamUrl='(.*?)';/.exec(meta)?.[1] ?? '').trim();
  return { title, streamUrl: streamUrl || null };
}

/** UTF-8 StreamTitle, as Icecast 2.4 sends it. Invalid UTF-8 is windows-1250. */
export function decodeIcyBytes(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1250').decode(bytes);
  }
}

export function splitIcyTitle(raw: string): NowPlayingTrack {
  const parts = raw.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const artist = parts[0]!.trim();
    const title = parts.slice(1).join(' - ').trim();
    if (artist && title) return { artist, title };
  }
  return { artist: null, title: raw.trim() };
}

/** Why this on-air text cannot be saved. `null` means Catch may store it. */
export function catchBlockReason(
  track: NowPlayingTrack | null,
  station: RadioStation,
): string | null {
  const title = track?.title?.trim() ?? '';
  const artist = track?.artist?.trim() ?? '';
  if (!title) return 'Nothing catchable is on air yet.';
  if (!artist || isGenericTitle(title, station) || isStationCredit(artist, station)) {
    return 'That’s the show, not a song.';
  }
  const keys = catchKeys(artist, title);
  if (!keys.artistKey || !keys.titleKey) return 'That’s the show, not a song.';
  return null;
}

/** Stable identity for de-duplicating a catch. */
export function catchKeys(artist: string, title: string): { artistKey: string; titleKey: string } {
  return {
    artistKey: normalize(artist).slice(0, 160),
    titleKey: normalize(title).slice(0, 160),
  };
}

function isStationCredit(raw: string, station: RadioStation): boolean {
  const n = normalize(raw);
  if (!n) return true;
  const stationName = normalize(station.name);
  if (n === stationName) return true;
  if (n.startsWith(stationName) && n.length < stationName.length + 24) return true;
  if (/radio\s*beat/.test(n) && /classic\s*rock/.test(n)) return true;
  if (/^radio\s*kiss$/.test(n)) return true;
  return false;
}

export function isGenericTitle(raw: string, station: RadioStation): boolean {
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
