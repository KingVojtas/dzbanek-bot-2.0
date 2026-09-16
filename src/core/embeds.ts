import { EmbedBuilder } from 'discord.js';
import { config } from '../config';
import type { EpicFreeGame, SteamDealItem, Track } from './types';

/**
 * Generic short reply embed (errors, confirmations, status).
 * Prefer domain-specific builders (track, queue, deals) when available.
 */
export function buildInfoEmbed(description: string, title?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setDescription(description.slice(0, 4096));
  if (title) embed.setTitle(title.slice(0, 256));
  return embed;
}

/** Format a duration in seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Live / Unknown';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((value, i) => (i === 0 ? String(value) : String(value).padStart(2, '0')))
    .join(':');
}

/** Human friendly view count e.g. "1.2M" or "3.4K". */
export function formatViews(count?: number): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M views';
  if (count >= 10_000) return Math.floor(count / 1_000) + 'K views';
  if (count >= 1_000) return (count / 1_000).toFixed(1).replace(/\.0$/, '') + 'K views';
  return count.toLocaleString() + ' views';
}

/** Embed for a single track (used by /play and now-playing). `label` is the author line. */
export function buildTrackEmbed(track: Track, label: string): EmbedBuilder {
  const color = track.source === 'spotify' ? 0x1db954 : config.embedColor;
  const pageUrl = track.sourceUrl || track.url;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: label })
    .setTitle(track.title.slice(0, 256))
    .setURL(pageUrl);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Duration', value: formatDuration(track.durationSec), inline: true },
    { name: 'Requested by', value: track.requestedBy, inline: true },
  ];

  if (track.uploader) {
    fields.push({ name: 'Uploader', value: track.uploader.slice(0, 100), inline: true });
  }

  const viewsStr = formatViews(track.views);
  if (viewsStr) {
    fields.push({ name: 'Views', value: viewsStr, inline: true });
  }

  if (track.uploadedAt) {
    fields.push({ name: 'Uploaded', value: track.uploadedAt, inline: true });
  }

  if (track.source && track.source !== 'youtube') {
    const badge = track.source === 'spotify' ? 'Spotify' : track.source;
    fields.push({ name: 'Source', value: badge, inline: true });
  }

  embed.addFields(fields);

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

/** Tracks shown per page in `/queue` (use buttons to flip pages). */
export const QUEUE_PAGE_SIZE = 8;

/**
 * Embed listing the current track and a page of upcoming items.
 * @param page 0-based page index into the upcoming queue.
 */
export function buildQueueEmbed(current: Track | null, queue: Track[], page = 0): EmbedBuilder {
  const pageSize = QUEUE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(queue.length / pageSize) || 1);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  const pageTracks = queue.slice(start, start + pageSize);

  let remainingSec = 0;
  for (const t of queue) {
    if (t.durationSec > 0) remainingSec += t.durationSec;
  }
  if (current && current.durationSec > 0) remainingSec += current.durationSec;

  const lines: string[] = [];

  if (current) {
    const npUrl = current.sourceUrl || current.url;
    const artist = current.uploader ? ` — *${current.uploader.slice(0, 60)}*` : '';
    lines.push(
      `▶ **Now playing**`,
      `[**${current.title.slice(0, 80)}**](${npUrl})${artist}`,
      `\`${formatDuration(current.durationSec)}\` · ${current.requestedBy}`,
    );
  } else {
    lines.push('▶ **Nothing playing**');
  }

  if (queue.length > 0) {
    lines.push('', `**Up next** · page **${safePage + 1}/${totalPages}**`);
    pageTracks.forEach((track, i) => {
      const n = start + i + 1;
      const url = track.sourceUrl || track.url;
      const title = track.title.slice(0, 70);
      const artist = track.uploader ? ` · ${track.uploader.slice(0, 40)}` : '';
      lines.push(
        `\` ${String(n).padStart(2, ' ')} \` [${title}](${url}) \`${formatDuration(track.durationSec)}\`${artist}`,
      );
    });
  } else if (current) {
    lines.push('', '*Queue is empty after this track.*');
  }

  const color = current?.source === 'spotify' ? 0x1db954 : config.embedColor;

  const footerParts: string[] = [];
  footerParts.push(`${queue.length} queued`);
  if (remainingSec > 0) footerParts.push(`~${formatDuration(remainingSec)} left`);
  footerParts.push(`Page ${safePage + 1}/${totalPages}`);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎶 Music Queue')
    .setDescription(lines.length > 0 ? lines.join('\n').slice(0, 4096) : 'The queue is empty.')
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  if (current?.thumbnail) embed.setThumbnail(current.thumbnail);

  return embed;
}

/** Total pages for an upcoming queue list. */
export function queueTotalPages(queueLength: number, pageSize = QUEUE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, queueLength) / pageSize) || 1);
}

/** Steam's brand dark-blue color (#1b2838). */
const STEAM_COLOR = 0x1b2838;

/** Official Steam favicon — used as the digest thumbnail. */
const STEAM_THUMBNAIL = 'https://store.steampowered.com/favicon.ico';

/** Steam specials page — used as the digest title URL. */
const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';

/** Maximum number of deals shown in one digest embed (Discord allows 25 fields max). */
const DIGEST_MAX_ITEMS = 10;

/**
 * Builds a single digest embed listing up to 10 new Steam deals.
 *
 * Layout:
 *   Thumbnail : Steam logo
 *   Title     : 🎮 Steam Daily Deals  (links to Steam specials)
 *   Description: deal count + best discount teaser
 *   Fields    : one row per deal — game name as the field name,
 *               price/discount/expiry + "View on Steam" link as the value
 *   Footer    : Steam Deals • game-deals.app
 *   Timestamp : time the embed was built
 */
export function buildSteamDealsDigestEmbed(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, string>,
): EmbedBuilder {
  const top = items.slice(0, DIGEST_MAX_ITEMS);
  const best = topDiscountPct(top);

  const embed = new EmbedBuilder()
    .setColor(STEAM_COLOR)
    .setTitle('🎮 Steam Daily Deals')
    .setURL(STEAM_SPECIALS_URL)
    .setThumbnail(STEAM_THUMBNAIL)
    .setDescription(
      `**Top ${top.length} Steam deal${top.length !== 1 ? 's' : ''}** right now` +
        (best > 0 ? ` — up to **${best}% off**` : '') +
        '.',
    )
    .setFooter({ text: 'Steam Deals • game-deals.app' })
    .setTimestamp();

  for (const [i, item] of top.entries()) {
    embed.addFields({
      name: `${i + 1}. ${item.gameName.slice(0, 250)}`,
      value: buildSteamFieldValue(item, prices.get(item.id) ?? null, reviews.get(item.id)),
      inline: false,
    });
  }

  return embed;
}

function buildSteamFieldValue(
  item: SteamDealItem,
  apiPrice: string | null,
  reviewStr: string | undefined,
): string {
  const lines: string[] = [];

  lines.push(apiPrice ?? buildFallbackPrice(item));

  if (reviewStr) lines.push(reviewStr);

  const ratings: string[] = [];
  if (item.igdbRating) ratings.push(`IGDB ${item.igdbRating}`);
  if (item.metascore) ratings.push(`Meta ${item.metascore}`);
  if (item.dealScore) ratings.push(`Deal ${item.dealScore}`);
  if (ratings.length) lines.push(ratings.join(' • '));

  if (item.genres) {
    lines.push(`🎮 ${item.genres}`);
  }

  if (item.expires) {
    lines.push(`📅 Expires **${item.expires}**`);
  }

  lines.push(`[View on Steam →](${item.link})`);

  return lines.join('\n').slice(0, 1024);
}

function buildFallbackPrice(item: SteamDealItem): string {
  const parts: string[] = [];
  if (item.salePrice && item.originalPrice && item.discount) {
    parts.push(`~~${item.originalPrice}~~ → **${item.salePrice}** (${item.discount})`);
  } else {
    if (item.salePrice) parts.push(`**${item.salePrice}**`);
    if (item.originalPrice) parts.push(`~~${item.originalPrice}~~`);
    if (item.discount) parts.push(`(${item.discount})`);
  }
  return parts.length > 0 ? parts.join('  ') : 'Free to play';
}

function topDiscountPct(items: SteamDealItem[]): number {
  return items.reduce((max, item) => {
    if (!item.discount) return max;
    const n = parseInt(item.discount.replace(/\D/g, ''), 10);
    return !Number.isNaN(n) && n > max ? n : max;
  }, 0);
}

/** Epic Games Store dark color (#2F2D2E). */
const EPIC_COLOR = 0x2f2d2e;

const EPIC_THUMBNAIL = 'https://store.epicgames.com/favicon.ico';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/**
 * Builds a single embed listing all currently-free and upcoming-free Epic games.
 *
 * Layout:
 *   Thumbnail : Epic favicon
 *   Title     : 🎁 Epic Games — Free This Week  (links to free games page)
 *   Description: count + CTA
 *   Fields    : one row per current free game, then a separator, then upcoming
 *   Image     : OfferImageWide of the first currently-free game
 *   Footer    : Epic Games Store • Free Games
 *   Timestamp : time the embed was built
 */
export function buildEpicFreeGamesEmbed(games: EpicFreeGame[]): EmbedBuilder {
  const current = games.filter((g) => !g.isUpcoming);
  const upcoming = games.filter((g) => g.isUpcoming);

  const embed = new EmbedBuilder()
    .setColor(EPIC_COLOR)
    .setTitle('🎁 Epic Games — Free This Week')
    .setURL(EPIC_FREE_URL)
    .setThumbnail(EPIC_THUMBNAIL)
    .setDescription(
      current.length > 0
        ? `**${current.length} free game${current.length !== 1 ? 's' : ''}** available right now — no purchase needed.\nClick a title to claim on the Epic Games Store.`
        : '🕐 No games are free right now. Check back soon!',
    )
    .setFooter({ text: 'Epic Games Store • Free Games' })
    .setTimestamp();

  for (const game of current) {
    embed.addFields({ name: game.title, value: epicFieldValue(game), inline: false });
  }

  const heroImage = (current[0] ?? upcoming[0])?.image;
  if (heroImage) embed.setImage(heroImage);

  if (upcoming.length > 0) {
    embed.addFields({ name: '\u200b', value: '**🔜 Coming Next Week**', inline: false });
    for (const game of upcoming) {
      embed.addFields({ name: game.title, value: epicFieldValue(game), inline: false });
    }
  }

  return embed;
}

function epicFieldValue(game: EpicFreeGame): string {
  const lines: string[] = [];

  if (game.description) {
    const shortDesc = game.description.replace(/\s+/g, ' ').slice(0, 120);
    lines.push(shortDesc + (game.description.length > 120 ? '…' : ''));
  }

  if (game.isUpcoming) {
    if (game.upcomingStartDate) lines.push(`🕐 Free from **${epicDate(game.upcomingStartDate)}**`);
    if (game.endDate) lines.push(`📅 Until **${epicDate(game.endDate)}**`);
    if (game.originalPrice) lines.push(`Worth ${game.originalPrice}`);
    lines.push(`[View on Epic \u2192](${game.storeUrl})`);
  } else {
    lines.push(game.originalPrice ? `~~${game.originalPrice}~~ \u2192 **FREE**` : '**FREE**');
    if (game.endDate) lines.push(`📅 Until **${epicDate(game.endDate)}**`);
    if (game.seller) lines.push(`🏢 ${game.seller.slice(0, 60)}`);
    lines.push(`[Claim for Free \u2192](${game.storeUrl})`);
  }

  return lines.join('\n').slice(0, 1024);
}

function epicDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
