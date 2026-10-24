import { STEAM_DIGEST_SIZE } from '../../core/display/steam';
import type { SteamDealItem } from '../../core/types';
import { extractAppId } from './SteamPriceApi';
import { isSteamFloorPrice, uniqueSteamApps } from './select-digest';

const FEATURED_URL = 'https://store.steampowered.com/api/featuredcategories?cc=de&l=english';

export interface SteamSpecialsList {
  items: SteamDealItem[];
  /** Search-row review counts, keyed by app id. Used to pick which sales to look up. */
  reviewCounts: Map<string, number>;
}

/**
 * Steam's public search has no "sort by discount" option. Reviews_DESC is
 * dominated by small games, and the cheapest page is the 0,49€ floor. The
 * expensive specials plus Steam's featured deals are where the blockbusters sit.
 */
const SEARCH_URL = 'https://store.steampowered.com/search/results/';
const PAGE_SIZE = 50;
const POPULAR_PAGES = [0, PAGE_SIZE];
const PREMIUM_PAGES = [0, PAGE_SIZE];

interface SearchPage {
  sort: 'Price_ASC' | 'Price_DESC' | 'Reviews_DESC';
  start: number;
}

interface FeaturedItem {
  id?: number;
  type?: number;
  name?: string;
  discounted?: boolean;
  discount_percent?: number;
  original_price?: number;
  final_price?: number;
  large_capsule_image?: string;
  header_image?: string;
  discount_expiration?: number;
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
    const [featured, premium, popular] = await Promise.all([
      this.readFeatured(),
      this.collect(PREMIUM_PAGES.map((start) => ({ sort: 'Price_DESC', start }))),
      this.collect(POPULAR_PAGES.map((start) => ({ sort: 'Reviews_DESC', start }))),
    ]);
    let batch = mergeSpecials(mergeSpecials(featured, premium), popular);
    const aboveFloor = batch.items.filter((item) => !isSteamFloorPrice(item)).length;
    if (aboveFloor < STEAM_DIGEST_SIZE) {
      const backup = await this.collect([
        { sort: 'Price_ASC', start: 0 },
        { sort: 'Price_ASC', start: PAGE_SIZE },
      ]);
      batch = mergeSpecials(batch, backup);
      if (batch.items.length === 0) {
        const error = popular.error ?? premium.error ?? backup.error;
        if (error) throw error;
      }
    }
    return { items: batch.items, reviewCounts: batch.reviewCounts };
  }

  /** Featured discounts and top sellers. This is where Red Dead shows up. */
  private async readFeatured(): Promise<CollectedSpecials> {
    try {
      const response = await fetch(FEATURED_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return emptySpecials();
      const json = (await response.json()) as {
        specials?: { items?: FeaturedItem[] };
        top_sellers?: { items?: FeaturedItem[] };
      };
      const rows = [...(json.specials?.items ?? []), ...(json.top_sellers?.items ?? [])];
      const batch = emptySpecials();
      for (const row of rows) {
        const appId = row.id ? String(row.id) : '';
        const percent = Number(row.discount_percent) || 0;
        if (!appId || !percent || row.discounted === false) continue;
        if (row.type != null && row.type !== 0) continue;
        const name = (row.name ?? '').replace(/\s+/g, ' ').trim();
        const expires =
          row.discount_expiration && row.discount_expiration > 0
            ? new Date(row.discount_expiration * 1000).toISOString()
            : undefined;
        batch.items.push({
          id: `steam_${appId}`,
          title: name || `App ${appId}`,
          gameName: name || `App ${appId}`,
          link: `https://store.steampowered.com/app/${appId}/`,
          discount: `-${percent}%`,
          salePrice: formatEuroCents(row.final_price),
          originalPrice: formatEuroCents(row.original_price),
          image: row.large_capsule_image || row.header_image,
          expires,
        });
      }
      return { ...batch, items: uniqueSteamApps(batch.items) };
    } catch {
      return emptySpecials();
    }
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

/**
 * The moment the current price stops, as an ISO time the card counts down to.
 * One store request for the whole digest.
 * A missing answer leaves whatever end date the feed or featured list already had.
 */
export async function attachSteamSaleEnds(items: SteamDealItem[]): Promise<void> {
  const ids = [
    ...new Set(
      items.map((item) => extractAppId(item.link)).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return;
  const ends = await fetchSaleEnds(ids);
  for (const item of items) {
    const appId = extractAppId(item.link);
    const end = appId ? ends.get(appId) : undefined;
    if (end) item.expires = end;
  }
}

async function fetchSaleEnds(appIds: string[]): Promise<Map<string, string>> {
  const ends = new Map<string, string>();
  try {
    const input = {
      ids: appIds.map((appId) => ({ appid: Number(appId) })),
      context: { language: 'english', country_code: 'DE', steam_realm: 1 },
      data_request: { include_all_purchase_options: true },
    };
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return ends;
    const json = (await response.json()) as {
      response?: {
        store_items?: Array<{
          appid?: number;
          best_purchase_option?: { active_discounts?: Array<{ discount_end_date?: number }> };
        }>;
      };
    };
    const now = Date.now() / 1000;
    for (const item of json.response?.store_items ?? []) {
      const appId = item.appid ? String(item.appid) : '';
      if (!appId) continue;
      const upcoming = (item.best_purchase_option?.active_discounts ?? [])
        .map((discount) => discount.discount_end_date ?? 0)
        .filter((stamp) => stamp > now);
      if (upcoming.length === 0) continue;
      ends.set(appId, new Date(Math.min(...upcoming) * 1000).toISOString());
    }
  } catch {
    return ends;
  }
  return ends;
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
    const released = decodeHtml(block.match(/search_released[^>]*>\s*([^<]+)/i)?.[1] ?? '');
    const tagRaw = beforeTitle.match(/data-ds-tagids="\[([0-9,\s]*)\]"/i);
    const tagIds = (tagRaw?.[1] ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);
    batch.items.push({
      id: `steam_${appId}`,
      title: name,
      gameName: name || `App ${appId}`,
      link: `https://store.steampowered.com/app/${appId}/`,
      salePrice: finalPrice?.[1]?.trim(),
      originalPrice: original?.[1]?.trim(),
      discount: `-${percent}%`,
      image: /^https?:\/\//i.test(capsule) ? capsule : undefined,
      released: released || undefined,
      tagIds: tagIds.length > 0 ? tagIds : undefined,
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

function formatEuroCents(cents: number | undefined): string | undefined {
  if (cents == null || !Number.isFinite(cents)) return undefined;
  const whole = Math.trunc(cents / 100);
  const frac = String(Math.abs(cents) % 100).padStart(2, '0');
  return `${whole},${frac}€`;
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
