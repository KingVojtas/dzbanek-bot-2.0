import { STEAM_DIGEST_SIZE } from '../../core/display';
import type { SteamDealItem } from '../../core/types';
import { isSteamFloorPrice, uniqueSteamApps } from './select-digest';

export interface SteamSpecialsList {
  items: SteamDealItem[];
  /** Search-row review counts, keyed by app id. Used to pick which sales to look up. */
  reviewCounts: Map<string, number>;
}

/**
 * Steam's public search has no "sort by discount" option. The cheapest page
 * is entirely the 0,49€ minimum, so the digest is built from the best-reviewed
 * specials. Price_ASC is only a backfill when that pool is short.
 */
const SEARCH_URL = 'https://store.steampowered.com/search/results/';
const PAGE_SIZE = 50;
const POPULAR_PAGES = [0, PAGE_SIZE];

interface SearchPage {
  sort: 'Price_ASC' | 'Reviews_DESC';
  start: number;
}

interface SearchResponse {
  success?: number;
  results_html?: string;
}

/**
 * Current Steam specials, one row per app. The curated RSS feed is often only
 * a couple of new discounts; this list is what fills the daily card to 10.
 */
export class SteamSpecialsReader {
  async read(): Promise<SteamSpecialsList> {
    const popular = await this.collect(
      POPULAR_PAGES.map((start) => ({ sort: 'Reviews_DESC', start })),
    );
    let batch = popular;
    const aboveFloor = batch.items.filter((item) => !isSteamFloorPrice(item)).length;
    if (aboveFloor < STEAM_DIGEST_SIZE) {
      const backup = await this.collect([
        { sort: 'Price_ASC', start: 0 },
        { sort: 'Price_ASC', start: PAGE_SIZE },
      ]);
      batch = mergeSpecials(batch, backup);
      if (batch.items.length === 0) {
        const error = popular.error ?? backup.error;
        if (error) throw error;
      }
    }
    return { items: batch.items, reviewCounts: batch.reviewCounts };
  }

  private async collect(pages: SearchPage[]): Promise<CollectedSpecials> {
    const settled = await Promise.allSettled(pages.map((page) => this.fetchPage(page)));
    let batch = emptySpecials();
    for (const result of settled) {
      if (result.status === 'fulfilled') batch = mergeSpecials(batch, result.value);
      else {
        batch.error =
          result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      }
    }
    return batch;
  }

  private async fetchPage(page: SearchPage): Promise<CollectedSpecials> {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', '');
    url.searchParams.set('start', String(page.start));
    url.searchParams.set('count', String(PAGE_SIZE));
    url.searchParams.set('specials', '1');
    url.searchParams.set('infinite', '1');
    url.searchParams.set('cc', 'de');
    url.searchParams.set('l', 'english');
    url.searchParams.set('hidef2p', '1');
    url.searchParams.set('category1', '998');
    url.searchParams.set('sort_by', page.sort);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Steam specials HTTP ${response.status} (${page.sort} @ ${page.start})`);
    }

    const text = await response.text();
    let json: SearchResponse;
    try {
      json = JSON.parse(text) as SearchResponse;
    } catch {
      throw new Error(`Steam specials did not return JSON (${page.sort} @ ${page.start})`);
    }
    if (!json.results_html) return emptySpecials();
    return parseSteamSearchHtml(json.results_html);
  }
}

interface CollectedSpecials extends SteamSpecialsList {
  error: Error | null;
}

function emptySpecials(): CollectedSpecials {
  return { items: [], reviewCounts: new Map(), error: null };
}

function mergeSpecials(left: CollectedSpecials, right: CollectedSpecials): CollectedSpecials {
  const reviewCounts = new Map(left.reviewCounts);
  for (const [appId, count] of right.reviewCounts) {
    reviewCounts.set(appId, Math.max(reviewCounts.get(appId) ?? 0, count));
  }
  return {
    items: uniqueSteamApps([...left.items, ...right.items]),
    reviewCounts,
    error: left.error ?? right.error,
  };
}

/** Pull discounted games out of a Steam search `results_html` blob. */
export function parseSteamSearchHtml(html: string): CollectedSpecials {
  const rowRe =
    /<a href="https:\/\/store\.steampowered\.com\/app\/(\d+)\/[^"]*"([\s\S]*?)<span class="title">([^<]+)<\/span>([\s\S]*?)(?=<a href="https:\/\/store\.steampowered\.com\/|$)/g;
  const batch = emptySpecials();
  for (const match of html.matchAll(rowRe)) {
    const appId = match[1];
    const beforeTitle = match[2] ?? '';
    const block = match[4] ?? '';
    if (!appId) continue;
    const discount = block.match(/data-discount="(\d+)"/);
    const percent = discount ? Number(discount[1]) : 0;
    if (!percent) continue;

    const original = block.match(/discount_original_price"[^>]*>\s*([^<]+)/);
    const finalPrice = block.match(/discount_final_price"[^>]*>\s*([^<]+)/);
    const name = decodeHtml(match[3] ?? '');
    const capsule = decodeHtml(beforeTitle.match(/<img[^>]*\ssrc="([^"]+)"/i)?.[1] ?? '');
    batch.items.push({
      id: `steam_${appId}`,
      title: name,
      gameName: name || `App ${appId}`,
      link: `https://store.steampowered.com/app/${appId}/`,
      salePrice: finalPrice?.[1]?.trim(),
      originalPrice: original?.[1]?.trim(),
      discount: `-${percent}%`,
      image: /^https?:\/\//i.test(capsule) ? capsule : undefined,
    });

    const tooltip = decodeHtml(block.match(/data-tooltip-html="([^"]*)"/)?.[1] ?? '');
    const reviews = tooltip.match(/(\d+)% of the ([\d,]+) user reviews/i);
    const count = reviews ? Number(reviews[2]?.replace(/,/g, '')) : 0;
    if (count > 0) {
      batch.reviewCounts.set(appId, Math.max(batch.reviewCounts.get(appId) ?? 0, count));
    }
  }
  return batch;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
