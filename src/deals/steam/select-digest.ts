import type { SteamDealItem } from '../../core/types';
import { extractAppId, parseDiscountPercent } from './SteamPriceApi';
import { isGoodReview, type SteamReviewInfo } from './SteamReviewApi';

export function compareSteamDiscount(a: SteamDealItem, b: SteamDealItem): number {
  const da = parseDiscountPercent(a.discount) ?? 0;
  const db = parseDiscountPercent(b.discount) ?? 0;
  if (db !== da) return db - da;
  return a.gameName.localeCompare(b.gameName);
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
  const sorted = [...items].sort(compareSteamDiscount);
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

export function steamDigestFingerprint(items: SteamDealItem[]): string {
  return items.map((item) => item.id).join('|');
}
