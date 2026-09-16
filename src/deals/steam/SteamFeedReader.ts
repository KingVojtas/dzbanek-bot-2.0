import Parser from 'rss-parser';
import type { SteamDealItem } from '../../core/types';

export const STEAM_FEED_URL = 'https://game-deals.app/rss/discounts/steam';
export const STEAM_SEEN_SCOPE = 'steam:deals';

/**
 * Reads the game-deals.app Steam discount RSS feed and normalises each item.
 *
 * title  : "DJMAX RESPECT V (-80% €8.39)"
 * link   : https://store.steampowered.com/app/960170/…
 * guid   : steam_960170_25June   ← stable dedup key
 */
export class SteamFeedReader {
  private readonly parser = new Parser();

  async read(): Promise<SteamDealItem[]> {
    const parsed = await this.parser.parseURL(STEAM_FEED_URL);
    return (parsed.items ?? []).map((item) => toSteamDealItem(item));
  }
}

function toSteamDealItem(item: Parser.Item): SteamDealItem {
  const content = item.content ?? item.contentSnippet ?? '';
  const link = item.link ?? '';
  return {
    id: item.guid ?? link ?? item.title ?? '',
    title: item.title ?? 'Unknown Deal',
    gameName: extractGameName(item.title ?? ''),
    link,
    image: extractAppImage(link),
    isoDate: item.isoDate,
    ...parseContent(content),
  };
}

function extractGameName(title: string): string {
  const match = title.match(/^(.+?)\s+\(-?\d+%/);
  return match ? match[1].trim() : title;
}

function extractAppImage(link: string): string | undefined {
  const match = link.match(/store\.steampowered\.com\/app\/(\d+)\//);
  if (!match) return undefined;
  return `https://cdn.akamai.steamstatic.com/steam/apps/${match[1]}/header.jpg`;
}

function parseContent(content: string): {
  description?: string;
  salePrice?: string;
  originalPrice?: string;
  discount?: string;
  expires?: string;
  publisher?: string;
  igdbRating?: string;
  metascore?: string;
  dealScore?: string;
  genres?: string;
} {
  const noImages = content
    .replace(/<img[^>]*>/gi, '')
    .replace(/!\[[^\]]*?\]\([^)]*?\)/g, '')
    .replace(/https?:\/\/[^\s"'<>()]+?\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s"'<>()]*)?/gi, '');

  const priceSplit = noImages.split(/<strong>\s*Price:\s*<\/strong>| \*\*Price:\s*\*\*/i);
  let description =
    (priceSplit[0] || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[View Deal\]\([^)]*\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || undefined;

  if (description && description.length > 160) {
    description = description.slice(0, 160).trim() + '…';
  }

  const priceMatch =
    content.match(
      /(?:<strong>\s*Price:\s*<\/strong>| \*\*Price:\s*\*\*)\s*(\S+)\s+(?:<s>|~~)?(\S+)(?:<\/s>|~~)?\s*\(([^)]+)\)/i,
    ) || content.match(/\*\*Price:\s*\*\*\s*(\S+)\s+(\S+)\s+\(([^)]+)\)/);

  return {
    description,
    salePrice: priceMatch?.[1]?.trim(),
    originalPrice: priceMatch?.[2]?.trim(),
    discount: priceMatch?.[3]?.trim(),
    expires: extractField(content, 'Expires'),
    publisher: extractField(content, 'Publisher'),
    igdbRating: extractField(content, 'IGDB Rating'),
    metascore: extractField(content, 'Metascore'),
    dealScore: extractField(content, 'Deal Score'),
    genres: extractField(content, 'Genres'),
  };
}

function extractField(content: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let match = content.match(new RegExp(`<strong>\\s*${escaped}:\\s*</strong>\\s*([^<\\n]+)`, 'i'));
  if (match?.[1]) return match[1].trim();
  match = content.match(new RegExp(`\\*\\*${escaped}:\\s*\\*\\*\\s*([^\\n*]+)`));
  return match?.[1]?.trim() || undefined;
}
