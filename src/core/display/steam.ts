import { ContainerBuilder, MessageFlags, SectionBuilder, TextDisplayBuilder } from 'discord.js';
import { isGoodReview, type SteamReviewInfo } from '../../deals/steam/SteamReviewApi';
import { SITE_STEAM } from '../embeds';
import type { SteamDealItem } from '../types';
import { euros, linkText, linked, moneyToCents, plainBlurb, pragueDay } from './text';
import {
  addBlock,
  artSection,
  divider,
  fitsV2,
  httpImage,
  linkButton,
  textBlock,
  type V2Display,
} from './v2';

const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';

/** Games per Steam digest. */
export const STEAM_DIGEST_SIZE = 10;

/**
 * In the current Steam card's footer, and part of the digest fingerprint.
 * Change it when the layout changes: every server's card is replaced once.
 */
export const STEAM_SHELF_MARKER = 'euro prices · Steam DE';

/** 650000 → "650K", 1200000 → "1.2M". */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function fallbackPriceLine(item: SteamDealItem): string {
  if (item.salePrice && item.originalPrice) {
    return `~~${item.originalPrice}~~ → **${item.salePrice}**`;
  }
  if (item.salePrice) return `**${item.salePrice}**`;
  return '';
}

export interface SteamPriceBits {
  /** 75 for −75 %. Zero when unknown. */
  percent: number;
  /** What it costs today. */
  pay: string;
  /** The struck price. */
  was: string;
}

/** Discount, today's price, and the struck price, from the store answer or the feed row. */
export function steamPriceBits(item: SteamDealItem, apiPrice: string | null): SteamPriceBits {
  const source = apiPrice ?? fallbackPriceLine(item);
  const clean = (value: string | undefined): string => value?.replace(/<[^>]*>/g, '').trim() ?? '';
  const pay = clean(source.match(/\*\*([^*]+)\*\*/)?.[1] || item.salePrice);
  let was = clean(
    source.match(/~~([^~]+)~~/)?.[1] || (item.salePrice ? item.originalPrice : undefined),
  );
  const fromPrice = apiPrice?.match(/\((-?\d+)%\)\s*$/)?.[1];
  const n = parseInt(String(item.discount ?? fromPrice ?? '').replace(/\D/g, ''), 10);
  let percent = Number.isFinite(n) && n > 0 ? n : 0;
  // Same price twice is no sale: a feed row can lag behind Steam.
  const wasCents = moneyToCents(was);
  if (wasCents != null && wasCents === moneyToCents(pay)) {
    was = '';
    percent = 0;
  }
  return { percent, pay, was };
}

/** `−75%` chip, the struck price, today's price, and (with `save`) what stays in your pocket. */
export function steamMoneyLine(bits: SteamPriceBits, save = true): string {
  const chip = bits.percent ? `\`−${bits.percent}%\`` : '';
  const price = bits.pay
    ? bits.was
      ? `~~${bits.was}~~ → **${bits.pay}**`
      : `**${bits.pay}**`
    : '';
  const was = moneyToCents(bits.was);
  const pay = moneyToCents(bits.pay);
  const saved =
    save && was != null && pay != null && was > pay ? `you save ${euros(was - pay)}` : '';
  return [[chip, price].filter(Boolean).join(' '), saved].filter(Boolean).join(' · ');
}

const REVIEW_EMOJI: Record<string, string> = {
  'Overwhelmingly Positive': '🏆',
  'Very Positive': '💎',
  Positive: '👍',
  'Mostly Positive': '👍',
};

/** Steam's own label, only for a game players actually like. */
export function steamReviewChip(review: SteamReviewInfo | null | undefined): string {
  if (!review || !isGoodReview(review) || !review.scoreDesc) return '';
  const emoji = REVIEW_EMOJI[review.scoreDesc] ?? '⭐';
  return `${emoji} ${review.scoreDesc} · ${review.positivePct}% of ${compactCount(review.totalReviews)}`;
}

const SALE_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Closer than this, a countdown would read "ends 2 hours ago" before the next digest replaces the post. */
const SALE_COUNTDOWN_MIN_MS = 26 * 3_600_000;

/**
 * A live countdown when Steam gave the hour, the day otherwise. Empty once it has passed.
 * A sale ending within a day shows its date and time instead, which stays true after it passes.
 */
export function steamSaleEnds(value: string | undefined): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isFinite(ms) || ms <= Date.now()) return '';
    const style = ms - Date.now() < SALE_COUNTDOWN_MIN_MS ? 'f' : 'R';
    return `⏳ ends <t:${Math.floor(ms / 1000)}:${style}>`;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return `⏳ ends ${text.replace(/^(ends|until)\s+/i, '')}`;
  const month = SALE_MONTHS[Number(iso[2]) - 1] ?? '';
  return `⏳ ends ${Number(iso[3])} ${month}`;
}

/** Title as it appears in a digest row. Duplicate checks compare against this. */
export function steamDealTitle(item: SteamDealItem): string {
  return linkText(item.gameName, 80);
}

/** Steam's label alone, without the counts, for the digest's quiet line. */
function steamReviewLabel(review: SteamReviewInfo | null | undefined): string {
  if (!review || !isGoodReview(review) || !review.scoreDesc) return '';
  return `${REVIEW_EMOJI[review.scoreDesc] ?? '⭐'} ${review.scoreDesc}`;
}

/** "Action · Shooter · Open World" → "Action, Shooter, Open World". */
function tagLine(tags: string | undefined, limit: number): string {
  return (tags ?? '')
    .split('·')
    .map((tag) => tag.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');
}

function steamRow(
  rank: number,
  item: SteamDealItem,
  apiPrice: string | null,
  review: SteamReviewInfo | null | undefined,
  extras: SteamExtras,
  wishers: string[] = [],
): SectionBuilder | TextDisplayBuilder {
  const title = steamDealTitle(item);
  const lines = [
    `**${rank}. ${linked(title, item.link)}**`,
    steamMoneyLine(steamPriceBits(item, apiPrice), false),
  ];
  const blurb = extras.blurb > 0 ? plainBlurb(item.description, extras.blurb) : '';
  if (blurb) lines.push(blurb);
  const meta = [
    extras.tags ? tagLine(item.tags, 3) : '',
    steamReviewLabel(review),
    wisherLine(wishers),
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) lines.push(`-# ${meta}`);
  // Its own last line, so the sale end closes the row.
  const ends = steamSaleEnds(item.expires);
  if (ends) lines.push(`-# ${ends}`);
  return artSection(lines, httpImage(item.image), title, { label: 'Store', url: item.link });
}

interface SteamExtras {
  /** Longest blurb in characters; 0 leaves it out. */
  blurb: number;
  tags: boolean;
}

/** `👀 <@a>, <@b>`: members whose Steam wishlist has this game. Empty for nobody. */
function wisherLine(userIds: string[]): string {
  return userIds.length > 0 ? `👀 ${userIds.map((id) => `<@${id}>`).join(', ')}` : '';
}

function steamContainer(
  top: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, SteamReviewInfo | null>,
  extras: SteamExtras,
  wishers: Map<string, string[]>,
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(SITE_STEAM);

  if (top.length === 0) {
    container.addTextDisplayComponents(
      textBlock(['The shelf is empty right now. Steam is between sales.']),
    );
  }
  top.forEach((item, i) =>
    addBlock(
      container,
      steamRow(
        i + 1,
        item,
        prices.get(item.id) ?? null,
        reviews.get(item.id),
        extras,
        wishers.get(item.id),
      ),
    ),
  );

  container
    .addSeparatorComponents(divider())
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          textBlock([`-# 💸 Steam Daily Deals · ${pragueDay()} · ${STEAM_SHELF_MARKER}`]),
        )
        .setButtonAccessory(linkButton('All specials', STEAM_SPECIALS_URL)),
    );
  return container;
}

/**
 * Steam digest: ten numbered store rows, each with its art, price, a short
 * description, the game's style, Steam's review label, and when the sale ends.
 */
export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, SteamReviewInfo | null> = new Map(),
  /** Deal id → members who wishlisted it. Shown as mentions; send with pings off. */
  wishers: Map<string, string[]> = new Map(),
): V2Display {
  const top = items.slice(0, STEAM_DIGEST_SIZE);
  // Near Discord's text cap the blurbs shorten first, then go, then the tags. Prices stay.
  const tries: SteamExtras[] = [
    { blurb: 120, tags: true },
    { blurb: 90, tags: true },
    { blurb: 0, tags: true },
    { blurb: 0, tags: false },
  ];
  let container = steamContainer(top, prices, reviews, tries[0]!, wishers);
  for (const extras of tries.slice(1)) {
    if (fitsV2([container])) break;
    container = steamContainer(top, prices, reviews, extras, wishers);
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
