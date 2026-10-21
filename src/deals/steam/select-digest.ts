import type { SteamDealItem } from '../../core/types';
import { extractAppId, parseDiscountPercent } from './SteamPriceApi';
import { isGoodReview, type SteamReviewInfo } from './SteamReviewApi';

export function steamDiscountPercent(item: SteamDealItem): number {
  return parseDiscountPercent(item.discount) ?? 0;
}

/**
 * Deepest discount first. `weight` breaks ties (review count). Equal weights
 * fall back to the game name so the lineup stays stable.
 */
export function compareSteamDeals(
  a: SteamDealItem,
  b: SteamDealItem,
  weight: (item: SteamDealItem) => number = () => 0,
): number {
  const delta = steamDiscountPercent(b) - steamDiscountPercent(a);
  if (delta !== 0) return delta;
  const byWeight = weight(b) - weight(a);
  if (byWeight !== 0) return byWeight;
  return a.gameName.localeCompare(b.gameName);
}

export function compareSteamDiscount(a: SteamDealItem, b: SteamDealItem): number {
  return compareSteamDeals(a, b);
}

/**
 * Steam will not sell a normal game below this. The cheapest specials page is
 * nothing but that floor, so those rows are not useful daily deals.
 */
const STEAM_FLOOR_CENTS = 49;

export function isSteamFloorPrice(item: SteamDealItem): boolean {
  const cents = parseMoneyCents(item.salePrice);
  return cents != null && cents <= STEAM_FLOOR_CENTS;
}

function parseMoneyCents(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/\s/g, '').match(/(\d+)[,.](\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number(match[2]);
}

/** The search-row capsule. A guessed library filename is not one of these. */
function isLiveStoreImage(url: string | undefined): boolean {
  return Boolean(url && /store_item_assets|\/capsule_\d+x\d+/i.test(url));
}

/** Keep the first listing for each Steam app so the digest never repeats a game. */
export function uniqueSteamApps(items: SteamDealItem[]): SteamDealItem[] {
  const seen = new Map<string, SteamDealItem>();
  const out: SteamDealItem[] = [];
  for (const item of items) {
    const key = extractAppId(item.link) ?? item.id;
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      out.push(item);
      continue;
    }
    // The RSS row only has a guessed library URL. Keep the search capsule.
    if (isLiveStoreImage(item.image) && !isLiveStoreImage(existing.image)) {
      existing.image = item.image;
    }
    // Featured and RSS rows have no store tags. The search row does.
    if (!existing.released && item.released) existing.released = item.released;
    if (!existing.expires && item.expires) existing.expires = item.expires;
    if ((existing.tagIds?.length ?? 0) === 0 && (item.tagIds?.length ?? 0) > 0) {
      existing.tagIds = item.tagIds;
    }
  }
  return out;
}

/**
 * Build a fixed-size digest. Blockbusters come first (God of War, Red Dead,
 * and the other full-priced studio games), then the best-reviewed sales.
 * Deepest discount wins inside each group. The card is still filled to `size`.
 */
export function selectSteamDigest(
  items: SteamDealItem[],
  reviewMap: Map<string, SteamReviewInfo | null>,
  size: number,
): SteamDealItem[] {
  if (size <= 0) return [];
  const weight = (item: SteamDealItem): number => reviewMap.get(item.id)?.totalReviews ?? 0;
  const byDeal = (a: SteamDealItem, b: SteamDealItem): number => compareSteamDeals(a, b, weight);
  const good = (item: SteamDealItem): boolean => {
    const review = reviewMap.get(item.id);
    return Boolean(review && isGoodReview(review));
  };
  const buckets = [
    items.filter((item) => item.blockbuster && good(item)),
    items.filter((item) => item.blockbuster),
    items.filter((item) => good(item)),
    items,
  ];
  const picked: SteamDealItem[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const item of [...bucket].sort(byDeal)) {
      if (picked.length >= size) return picked;
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      picked.push(item);
    }
  }
  return picked;
}

/** Bump when the card layout changes so today's post is replaced once. */
const STEAM_DIGEST_LAYOUT = 'site';

export function steamDigestFingerprint(items: SteamDealItem[]): string {
  return `${STEAM_DIGEST_LAYOUT}:${items.map((item) => item.id).join('|')}`;
}
