/** Steam profile and wishlist lookups for Wishlist Radar. None of them need an API key. */

const TIMEOUT_MS = 12_000;
const WISHLIST_MAX = 1_000;
const NAMES_CHUNK = 100;

export type SteamProfileInput = { kind: 'id'; steamId: string } | { kind: 'vanity'; name: string };

/**
 * What someone pasted into `/steam link`: a 17-digit SteamID64, a
 * `/profiles/<id>` or `/id/<name>` link, or a bare custom name. Null for junk.
 */
export function parseSteamProfileInput(text: string): SteamProfileInput | null {
  const value = text.trim();
  const profile = value.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profile) return { kind: 'id', steamId: profile[1]! };
  const vanity = value.match(/steamcommunity\.com\/id\/([\w-]{2,32})/i);
  if (vanity) return { kind: 'vanity', name: vanity[1]! };
  if (/^7656\d{13}$/.test(value)) return { kind: 'id', steamId: value };
  if (/^[\w-]{2,32}$/.test(value)) return { kind: 'vanity', name: value };
  return null;
}

/** SteamID64 for a pasted profile, or null when Steam knows no such profile. */
export async function resolveSteamId(text: string): Promise<string | null> {
  const input = parseSteamProfileInput(text);
  if (!input) return null;
  if (input.kind === 'id') return input.steamId;
  try {
    const response = await fetch(
      `https://steamcommunity.com/id/${encodeURIComponent(input.name)}/?xml=1`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const xml = await response.text();
    return xml.match(/<steamID64>(\d{17})<\/steamID64>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * App ids on a public wishlist, highest priority first. Steam answers a
 * private wishlist and an empty one the same way, so both come back empty.
 * Null when Steam could not be reached.
 */
export async function fetchWishlist(steamId: string): Promise<string[] | null> {
  try {
    const response = await fetch(
      `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as {
      response?: { items?: { appid?: number; priority?: number }[] };
    };
    return (json.response?.items ?? [])
      .filter((item) => typeof item.appid === 'number')
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .slice(0, WISHLIST_MAX)
      .map((item) => String(item.appid));
  } catch {
    return null;
  }
}

export interface SteamAppName {
  name: string;
  /** Store page, e.g. `https://store.steampowered.com/app/1145360/Hades/`. */
  url: string;
}

/** Names and store links for many games at once. Missing ids are left out. */
export async function fetchAppNames(appIds: string[]): Promise<Map<string, SteamAppName>> {
  const names = new Map<string, SteamAppName>();
  for (let start = 0; start < appIds.length; start += NAMES_CHUNK) {
    const chunk = appIds.slice(start, start + NAMES_CHUNK);
    const input = {
      ids: chunk.map((appId) => ({ appid: Number(appId) })),
      context: { language: 'english', country_code: 'DE', steam_realm: 1 },
    };
    try {
      const response = await fetch(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!response.ok) continue;
      const json = (await response.json()) as {
        response?: {
          store_items?: { appid?: number; name?: string; store_url_path?: string }[];
        };
      };
      for (const item of json.response?.store_items ?? []) {
        if (!item.appid || !item.name) continue;
        const path = item.store_url_path?.replace(/^\/+|\/+$/g, '') || `app/${item.appid}`;
        names.set(String(item.appid), {
          name: item.name,
          url: `https://store.steampowered.com/${path}/`,
        });
      }
    } catch {
      /* this chunk goes nameless; the rest still count */
    }
  }
  return names;
}
