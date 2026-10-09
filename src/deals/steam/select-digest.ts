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

/** Keep the first listing for each Steam app so the digest never repeats a game. */
export function uniqueSteamApps(items: SteamDealItem[]): SteamDealItem[] {
  const seen = new Set<string>();
  const out: SteamDealItem[] = [];
  for (const item of items) {
    const key = extractAppId(item.link) ?? item.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Build a fixed-size digest: Very Positive (or better) first, deepest
 * discounts first. If that is still short of `size`, fill from the rest of
 * the feed so the card is never a single leftover sale.
 */
export function selectSteamDigest(
  items: SteamDealItem[],
  reviewMap: Map<string, SteamReviewInfo | null>,
  size: number,
): SteamDealItem[] {
  if (size <= 0) return [];
  const weight = (item: SteamDealItem): number => reviewMap.get(item.id)?.totalReviews ?? 0;
  const sorted = [...items].sort((a, b) => compareSteamDeals(a, b, weight));
  const passing: SteamDealItem[] = [];
  const rest: SteamDealItem[] = [];
  for (const item of sorted) {
    const review = reviewMap.get(item.id);
    if (review && isGoodReview(review)) passing.push(item);
    else rest.push(item);
  }
  const picked = passing.slice(0, size);
  if (picked.length < size) {
    for (const item of rest) {
      if (picked.length >= size) break;
      picked.push(item);
    }
  }
  return picked;
}

/** Bump when the card layout changes so today's post is replaced once. */
const STEAM_DIGEST_LAYOUT = 'shelf';

export function steamDigestFingerprint(items: SteamDealItem[]): string {
  return `${STEAM_DIGEST_LAYOUT}:${items.map((item) => item.id).join('|')}`;
}
