const PRICE_CC = 'de';
const API_URL = 'https://store.steampowered.com/api/appdetails';

interface RawPriceOverview {
  currency: string;
  initial: number;
  final: number;
  discount_percent: number;
  initial_formatted: string;
  final_formatted: string;
}

interface RawAppEntry {
  success: boolean;
  data?: { price_overview?: RawPriceOverview };
}

export interface SteamPriceInfo {
  initialFormatted: string;
  finalFormatted: string;
  discountPercent: number;
}

export function extractAppId(link: string): string | null {
  const match = link.match(/store\.steampowered\.com\/app\/(\d+)\//);
  return match?.[1] ?? null;
}

export async function fetchSteamPrice(appId: string): Promise<SteamPriceInfo | null> {
  const url = `${API_URL}?appids=${appId}&filters=price_overview&cc=${PRICE_CC}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let json: Record<string, RawAppEntry>;
  try {
    json = (await response.json()) as Record<string, RawAppEntry>;
  } catch {
    return null;
  }

  const price = json[appId]?.data?.price_overview;
  if (!json[appId]?.success || !price) return null;

  return {
    initialFormatted: price.initial_formatted,
    finalFormatted: price.final_formatted,
    discountPercent: price.discount_percent,
  };
}

const PRICE_CHUNK = 50;

/**
 * Many games' Steam DE prices, 50 per request. Steam answers several ids at
 * once only with `filters=price_overview`. Free and unlisted games are missing.
 */
export async function fetchSteamPrices(appIds: string[]): Promise<Map<string, SteamPriceInfo>> {
  const prices = new Map<string, SteamPriceInfo>();
  const ids = [...new Set(appIds.filter((id) => /^\d+$/.test(id)))];
  for (let start = 0; start < ids.length; start += PRICE_CHUNK) {
    const chunk = ids.slice(start, start + PRICE_CHUNK);
    const url = `${API_URL}?appids=${chunk.join(',')}&filters=price_overview&cc=${PRICE_CC}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
        if (response.status === 429 && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        if (!response.ok) break;
        const json = (await response.json()) as Record<string, RawAppEntry>;
        for (const id of chunk) {
          const price = json[id]?.data?.price_overview;
          if (!json[id]?.success || !price) continue;
          prices.set(id, {
            initialFormatted: price.initial_formatted,
            finalFormatted: price.final_formatted,
            discountPercent: price.discount_percent,
          });
        }
      } catch {
        /* this chunk is skipped; the rest still count */
      }
      break;
    }
  }
  return prices;
}

/** Example: `~~41,99€~~ → **8,39€** (-80%)` */
export function formatSteamPrice(info: SteamPriceInfo): string {
  return `~~${info.initialFormatted}~~ → **${info.finalFormatted}** (-${info.discountPercent}%)`;
}

export function parseDiscountPercent(discount?: string): number | null {
  if (!discount) return null;
  const n = parseInt(discount.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
