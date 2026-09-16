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
    response = await fetch(url, { headers: { Accept: 'application/json' } });
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

/** Example: `~~41,99€~~ → **8,39€** (-80%)` */
export function formatSteamPrice(info: SteamPriceInfo): string {
  return `~~${info.initialFormatted}~~ → **${info.finalFormatted}** (-${info.discountPercent}%)`;
}

export function parseDiscountPercent(discount?: string): number | null {
  if (!discount) return null;
  const n = parseInt(discount.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
