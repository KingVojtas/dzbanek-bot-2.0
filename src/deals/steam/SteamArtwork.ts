import type { SteamDealItem } from '../../core/types';
import { extractAppId } from './SteamPriceApi';

const DISCORD_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';

type Probe = 'hit' | 'miss' | 'unsure';

function classicArt(appId: string, file: string): string {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/${file}`;
}

/** The capsule Steam just rendered in search. A guessed /steam/apps path is not this. */
export function liveStoreImage(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  if (/store_item_assets|\/capsule_\d+x\d+/i.test(url)) return url;
  return undefined;
}

/** A larger file in the same folder as the search capsule. Classic CDN paths miss these. */
function siblingArt(url: string | undefined, file: string): string | undefined {
  if (!url || !/capsule_231x87/i.test(url)) return undefined;
  if (file === 'header.jpg' || file === 'library_hero.jpg') {
    return url.replace(/capsule_231x87[^?]*/i, file);
  }
  return url.replace(/capsule_231x87/gi, file.replace(/\.jpg$/i, ''));
}

async function probe(url: string, method: 'HEAD' | 'GET'): Promise<Probe> {
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
      headers: {
        'User-Agent': DISCORD_UA,
        Accept: 'image/*',
        ...(method === 'GET' ? { Range: 'bytes=0-15' } : {}),
      },
    });
    const type = response.headers.get('content-type') ?? '';
    if (method !== 'GET' && (response.status === 404 || response.status === 410)) return 'miss';

    if (method === 'GET') {
      const buf = new Uint8Array(await response.arrayBuffer());
      const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const png = buf[0] === 0x89 && buf[1] === 0x50;
      const riff = buf[0] === 0x52 && buf[1] === 0x49;
      if (response.status === 404 || response.status === 410 || buf[0] === 0x3c) return 'miss';
      if (
        (response.ok || response.status === 206) &&
        (type.startsWith('image/') || jpeg || png || riff)
      ) {
        return 'hit';
      }
      return response.status >= 500 ? 'unsure' : 'miss';
    }

    if (response.status >= 500) return 'unsure';
    if (!response.ok) return 'miss';
    if (type.startsWith('image/') || type.includes('octet-stream')) return 'hit';
    if (type.includes('text/html') || type.includes('text/plain')) return 'miss';
    return 'unsure';
  } catch {
    return 'unsure';
  }
}

async function classify(url: string, cache: Map<string, Probe>): Promise<Probe> {
  const cached = cache.get(url);
  if (cached) return cached;
  const head = await probe(url, 'HEAD');
  const result = head === 'unsure' ? await probe(url, 'GET') : head;
  cache.set(url, result);
  return result;
}

async function firstHit(
  urls: Array<string | undefined>,
  cache: Map<string, Probe>,
): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    if ((await classify(url, cache)) === 'hit') return url;
  }
  return undefined;
}

async function officialHeader(appId: string): Promise<string | undefined> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) return undefined;
    const json = (await response.json()) as Record<string, { data?: { header_image?: string } }>;
    const header = json[appId]?.data?.header_image;
    return typeof header === 'string' && /^https?:\/\//i.test(header) ? header : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Point every deal at artwork Discord can fetch. Portrait library art wins
 * when it exists. Otherwise a real header, then the live store capsule.
 * A guessed URL that 404s is dropped.
 */
export async function attachSteamArtwork(items: SteamDealItem[]): Promise<void> {
  const cache = new Map<string, Probe>();
  const officialPending = new Map<string, Promise<string | undefined>>();
  const officialFor = (appId: string): Promise<string | undefined> => {
    let pending = officialPending.get(appId);
    if (!pending) {
      pending = officialHeader(appId);
      officialPending.set(appId, pending);
    }
    return pending;
  };

  const liveByItem = new Map<SteamDealItem, string | undefined>();

  await mapPool(items, 4, async (item) => {
    const appId = extractAppId(item.link);
    const live = liveStoreImage(item.image);
    liveByItem.set(item, live);
    const sharp = await firstHit(
      [
        appId ? classicArt(appId, 'library_600x900.jpg') : undefined,
        appId ? classicArt(appId, 'capsule_616x353.jpg') : undefined,
        appId ? classicArt(appId, 'header.jpg') : undefined,
        siblingArt(live, 'library_600x900.jpg'),
        siblingArt(live, 'capsule_616x353.jpg'),
        siblingArt(live, 'header.jpg'),
      ],
      cache,
    );
    if (sharp) {
      item.image = sharp;
      return;
    }

    const official = appId ? await officialFor(appId) : undefined;
    if (official && (await classify(official, cache)) === 'hit') {
      item.image = official;
      return;
    }

    item.image = live && (await classify(live, cache)) !== 'miss' ? live : undefined;
  });

  const lead = items[0];
  if (!lead) return;
  const appId = extractAppId(lead.link);
  const live = liveByItem.get(lead);
  const wide = await firstHit(
    [
      appId ? classicArt(appId, 'library_hero.jpg') : undefined,
      appId ? classicArt(appId, 'capsule_616x353.jpg') : undefined,
      appId ? classicArt(appId, 'header.jpg') : undefined,
      siblingArt(live, 'library_hero.jpg'),
      siblingArt(live, 'capsule_616x353.jpg'),
      siblingArt(live, 'header.jpg'),
    ],
    cache,
  );
  if (wide) {
    lead.heroImage = wide;
    return;
  }
  const official = appId ? await officialFor(appId) : undefined;
  if (official && (await classify(official, cache)) === 'hit') {
    lead.heroImage = official;
    return;
  }
  lead.heroImage = live && (await classify(live, cache)) !== 'miss' ? live : lead.image;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
