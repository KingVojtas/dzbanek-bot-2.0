import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { isGoodReview, type SteamReviewInfo } from '../deals/steam/SteamReviewApi';
import {
  QUEUE_PAGE_SIZE,
  SITE_CLAY,
  SITE_STEAM,
  buildSiteEmbed,
  formatClock,
  formatDuration,
  queueTotalPages,
  upcomingQueue,
  type EmbedCard,
  type SiteField,
} from './embeds';
import type { EpicFreeGame, LoopMode, SteamDealItem, Track } from './types';

const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';
const EPIC_COLOR = 0x26bbff;
const EPIC_LATER_COLOR = 0x8b93a7;

/** Games per Steam digest. */
export const STEAM_DIGEST_SIZE = 10;

/** In the current Steam card's footer. An older card without it is replaced once. */
export const STEAM_SHELF_MARKER = 'prices in € (Steam DE)';

/** In the current Epic card's footer. An older card without it is replaced once. */
export const EPIC_SHELF_MARKER = 'Free to keep forever once claimed';

const EPIC_FREE_MAX = 4;
const EPIC_SOON_MAX = 3;

/** Discord's cap on components in one message, nested ones included. */
export const V2_COMPONENT_MAX = 40;

/** Components V2 message: Steam, Epic, the Kitchen Board, and the cards beside them. */
export interface V2Display {
  components: ContainerBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
}

/** Every node with a component type counts toward the cap: buttons, thumbnails, and all. */
export function countV2Components(containers: { toJSON(): unknown }[]): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === 'number') count += 1;
    for (const value of Object.values(rec)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(containers.map((container) => container.toJSON()));
  return count;
}

/** Discord's cap on all the text in one Components V2 message. */
export const V2_TEXT_MAX = 4000;

/** Every text display's content, added up. */
export function v2TextLength(containers: { toJSON(): unknown }[]): number {
  let length = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.content === 'string') length += rec.content.length;
    for (const value of Object.values(rec)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(containers.map((container) => container.toJSON()));
  return length;
}

/** Inside both caps: the component count and the text. */
export function fitsV2(containers: { toJSON(): unknown }[]): boolean {
  return (
    countV2Components(containers) <= V2_COMPONENT_MAX && v2TextLength(containers) <= V2_TEXT_MAX
  );
}

const YOUTUBE_COLOR = 0xff0000;
const SPOTIFY_COLOR = 0x1db954;
const MUSIC_COLOR = 0x8b5cf6;

function musicAccent(source?: Track['source']): number {
  if (source === 'spotify') return SPOTIFY_COLOR;
  if (source === 'youtube') return YOUTUBE_COLOR;
  return MUSIC_COLOR;
}

function musicSourceLabel(source?: Track['source']): string {
  if (source === 'spotify') return 'Spotify';
  if (source === 'youtube') return 'YouTube';
  return 'Music';
}

function progressBar(positionSec: number, durationSec: number): string {
  const width = 14;
  if (durationSec <= 0) return '●' + '─'.repeat(width - 1);
  const ratio = Math.min(1, Math.max(0, positionSec / durationSec));
  const filled = Math.round(ratio * (width - 1));
  return '━'.repeat(filled) + '●' + '─'.repeat(Math.max(0, width - 1 - filled));
}

/** Square brackets would break the markdown link around a title. */
export function linkText(value: string, limit: number): string {
  return value.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function linked(text: string, url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? `[${text}](${url})` : text;
}

function upNextLine(count: number): string {
  return count > 0 ? `${count} up next` : 'Nothing up next';
}

/** A paused card goes grey, so it reads as stopped from across the chat. */
const PAUSED_COLOR = 0x8b93a7;

const LOOP_FOOTER: Record<LoopMode, string> = {
  off: '',
  track: '🔂 Repeating this track',
  queue: '🔁 Looping the queue',
};

function requesterOf(track: Track): string {
  return track.requestedById ? `<@${track.requestedById}>` : track.requestedBy;
}

/** Sum of the known lengths; `+` when some are unknown. */
function runtime(tracks: Track[]): string {
  const known = tracks.filter((track) => track.durationSec > 0);
  if (known.length === 0) return '';
  const total = known.reduce((sum, track) => sum + track.durationSec, 0);
  return `${formatClock(total)}${known.length < tracks.length ? '+' : ''}`;
}

export interface NowPlayingDisplayOptions {
  track: Track;
  /** Tracks after the current one. */
  queueLength: number;
  paused: boolean;
  loopMode: LoopMode;
  positionSec?: number;
  /** 1 = 100 %. */
  volume?: number;
  /** Enables ⏮ Previous. */
  hasHistory?: boolean;
  /** The track after this one, named on the card. */
  next?: Track | null;
}

/** Now Playing card, as on the website: who asked, the clock, the transport row. */
export function buildNowPlayingDisplay(opts: NowPlayingDisplayOptions): EmbedCard {
  const { track, queueLength, paused, loopMode } = opts;
  const positionSec = Math.max(0, opts.positionSec ?? 0);
  const durationSec = track.durationSec > 0 ? track.durationSec : 0;
  const volume = opts.volume ?? 1;
  const volumePct = Math.round(volume * 100);

  const artist = plainBlurb(track.uploader, 80);
  const description = [
    artist ? `by **${artist}**` : '',
    `\`${formatClock(positionSec)}\` ${progressBar(positionSec, durationSec)} \`${
      durationSec > 0 ? formatClock(durationSec) : 'Live'
    }\``,
  ]
    .filter(Boolean)
    .join('\n');

  // The edit ticker keeps this fresh; the relative half ticks on its own between edits.
  const endsAt = Math.floor(Date.now() / 1000 + Math.max(0, durationSec - positionSec));
  const timing: SiteField =
    !paused && durationSec > 0
      ? ['Ends', `<t:${endsAt}:t> · <t:${endsAt}:R>`]
      : ['Length', formatDuration(durationSec)];

  const next = opts.next;
  const upNext =
    loopMode === 'track'
      ? '🔂 This one again'
      : next
        ? [
            `${linked(linkText(next.title, 80), next.sourceUrl || next.url)} \`${formatDuration(next.durationSec)}\``,
            queueLength > 1 ? `and ${queueLength - 1} more` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'Nothing yet. `/play` adds more.';

  const footer = [upNextLine(queueLength), LOOP_FOOTER[loopMode]].filter(Boolean).join(' · ');

  const embed = buildSiteEmbed({
    color: paused ? PAUSED_COLOR : SITE_CLAY,
    author: `${paused ? '⏸️ Paused' : '🔊 Now Playing'} · ${musicSourceLabel(track.source)}`,
    title: track.title,
    url: track.sourceUrl || track.url,
    description,
    fields: [
      ['Requested by', requesterOf(track)],
      timing,
      ['Volume', `${volumePct < 100 ? '🔉' : '🔊'} ${volumePct}%`],
      ['Up next', upNext, true],
    ],
    footer,
    thumbnail: track.thumbnail,
  });

  const transport = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(paused ? 'music:resume' : 'music:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music:skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setLabel(loopMode === 'off' ? 'Loop' : loopMode === 'track' ? 'Repeat' : 'Queue')
      .setEmoji(loopMode === 'track' ? '🔂' : '🔁')
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
  );

  const extras = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:prev')
      .setLabel('Previous')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!opts.hasHistory),
    new ButtonBuilder()
      .setCustomId('music:voldown')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volume <= 0.25),
    new ButtonBuilder()
      .setCustomId('music:volup')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volume >= 1.5),
    new ButtonBuilder()
      .setCustomId('music:queue')
      .setLabel('Queue')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [transport, extras] };
}

/** Page buttons on the queue card. `queue:page:0` is the first page. */
export const QUEUE_BUTTON_PREFIX = 'queue:page:';

/** Queue card: what is on now, one numbered page of what follows, and the page buttons. */
export function buildQueueDisplay(current: Track | null, queue: Track[], page = 0): EmbedCard {
  const upcoming = upcomingQueue(current, queue);
  const totalPages = queueTotalPages(upcoming.length, QUEUE_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * QUEUE_PAGE_SIZE;
  const pageTracks = upcoming.slice(start, start + QUEUE_PAGE_SIZE);

  const lines: string[] = [];
  if (current) {
    const title = linkText(current.title, 200);
    lines.push(
      `🔊 **${linked(title, current.sourceUrl || current.url)}** \`${formatDuration(current.durationSec)}\``,
      `-# Requested by ${requesterOf(current)}`,
      '',
    );
  }
  if (pageTracks.length > 0) {
    const width = String(start + pageTracks.length).length;
    pageTracks.forEach((track, i) => {
      const title = linkText(track.title, 80);
      lines.push(
        `\`${String(start + i + 1).padStart(width)}.\` ${linked(title, track.sourceUrl || track.url)} \`${formatDuration(track.durationSec)}\` · ${requesterOf(track)}`,
      );
    });
  } else {
    lines.push('– Nothing up next. `/play` adds more.');
  }

  const total = runtime(upcoming);
  const embed = buildSiteEmbed({
    color: SITE_CLAY,
    author: '📜 Queue',
    title: [upNextLine(upcoming.length), total].filter(Boolean).join(' · '),
    description: lines.join('\n'),
    footer: `Page ${safePage + 1} of ${totalPages}`,
    thumbnail: current?.thumbnail,
  });

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${safePage - 1}`)
      .setLabel('Prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${safePage + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );

  return { embeds: [embed], components: [row] };
}

/** Compact “added to queue” card (no transport buttons). */
export function buildQueuedTrackDisplay(
  track: Track,
  opts: { label: string; footer?: string },
): V2Display {
  const linkUrl = track.sourceUrl || track.url;
  const titleLine = linkUrl
    ? `### [${track.title.slice(0, 200)}](${linkUrl})`
    : `### ${track.title.slice(0, 200)}`;
  const artist = (track.uploader ?? '').slice(0, 80);

  const lines = [`**${opts.label}** · ${musicSourceLabel(track.source)}`, titleLine];
  if (artist) lines.push(`*${artist}*`);
  lines.push(`\`${formatDuration(track.durationSec)}\` · ${track.requestedBy}`);
  if (opts.footer) lines.push(`-# ${opts.footer}`);

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );
  const thumb = thumbnailFor(track.thumbnail, track.title);
  if (thumb) section.setThumbnailAccessory(thumb);

  const container = new ContainerBuilder()
    .setAccentColor(musicAccent(track.source))
    .addSectionComponents(section);

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function thumbnailFor(url: string | undefined, alt: string): ThumbnailBuilder | null {
  if (!url || !/^(https?:\/\/|attachment:\/\/)/i.test(url)) return null;
  return new ThumbnailBuilder().setURL(url).setDescription(alt.slice(0, 100) || 'Artwork');
}

function httpImage(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

function textBlock(lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.filter(Boolean).join('\n').slice(0, 4000));
}

/**
 * A section has to carry a thumbnail or a button. Art wins; a store link
 * stands in when the art is missing, so a row never loses its shape.
 */
function artSection(
  lines: string[],
  art: string | undefined,
  alt: string,
  fallback?: { label: string; url: string | undefined },
): SectionBuilder | TextDisplayBuilder {
  const text = textBlock(lines);
  const thumb = thumbnailFor(art, alt);
  if (thumb)
    return new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory(thumb);
  if (fallback?.url && /^https?:\/\//i.test(fallback.url)) {
    return new SectionBuilder()
      .addTextDisplayComponents(text)
      .setButtonAccessory(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(fallback.label)
          .setURL(fallback.url),
      );
  }
  return text;
}

function addBlock(container: ContainerBuilder, block: SectionBuilder | TextDisplayBuilder): void {
  if (block instanceof SectionBuilder) container.addSectionComponents(block);
  else container.addTextDisplayComponents(block);
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true);
}

function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel(label.length <= 80 ? label : `${label.slice(0, 79).trimEnd()}…`)
    .setURL(url);
  return emoji ? button.setEmoji(emoji) : button;
}

function linkRow(buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    buttons.slice(0, 5),
  );
}

/** Discord timestamp: it ticks in every reader's own clock. Empty when unreadable. */
export function discordTime(iso: string | undefined, style: 'R' | 'D' | 'f' | 't'): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** "1.234,56€", "59,99€", "$19.99" → cents. Null when no number is there. */
export function moneyToCents(value: string | undefined): number | null {
  const digits = value?.replace(/[^\d.,]/g, '') ?? '';
  if (!/\d/.test(digits)) return null;
  const match = digits.match(/^(.*?)[.,](\d{2})$/);
  const whole = (match ? match[1]! : digits).replace(/[.,]/g, '');
  const cents = Number(whole || '0') * 100 + (match ? Number(match[2]) : 0);
  return Number.isFinite(cents) ? cents : null;
}

/** Steam's own euro style: `1.234,56€`. */
function euros(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString('de-DE');
  return `${whole},${String(cents % 100).padStart(2, '0')}€`;
}

/** 650000 → "650K", 1200000 → "1.2M". */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function plainBlurb(value: string | undefined, limit = 150): string {
  if (!value) return '';
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`[\]~|>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > 80 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

function pragueDay(): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Prague',
  }).format(new Date());
}

/* ---------- Steam ---------- */

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
  const pay = source.match(/\*\*([^*]+)\*\*/)?.[1]?.trim() || item.salePrice?.trim() || '';
  const was =
    source.match(/~~([^~]+)~~/)?.[1]?.trim() ||
    (item.salePrice ? (item.originalPrice?.trim() ?? '') : '');
  const fromPrice = apiPrice?.match(/\((-?\d+)%\)\s*$/)?.[1];
  const n = parseInt(String(item.discount ?? fromPrice ?? '').replace(/\D/g, ''), 10);
  return { percent: Number.isFinite(n) && n > 0 ? n : 0, pay, was };
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

/** A live countdown when Steam gave the hour, the day otherwise. Empty once it has passed. */
export function steamSaleEnds(value: string | undefined): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isFinite(ms) || ms <= Date.now()) return '';
    return `⏳ ends <t:${Math.floor(ms / 1000)}:R>`;
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

function steamRow(
  rank: number,
  item: SteamDealItem,
  apiPrice: string | null,
  review: SteamReviewInfo | null | undefined,
  extras: SteamExtras,
): SectionBuilder | TextDisplayBuilder {
  const title = steamDealTitle(item);
  const lines = [
    `**${rank}. ${linked(title, item.link)}**`,
    steamMoneyLine(steamPriceBits(item, apiPrice), false),
  ];
  const meta = extras.meta
    ? [steamReviewLabel(review), steamSaleEnds(item.expires)].filter(Boolean).join(' · ')
    : '';
  if (meta) lines.push(`-# ${meta}`);
  return artSection(lines, httpImage(item.image), title, { label: 'Store', url: item.link });
}

interface SteamExtras {
  hero: boolean;
  meta: boolean;
}

function steamContainer(
  top: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, SteamReviewInfo | null>,
  extras: SteamExtras,
): ContainerBuilder {
  const lead = top[0];
  const container = new ContainerBuilder().setAccentColor(SITE_STEAM);

  const hero = extras.hero ? httpImage(lead?.heroImage) : undefined;
  if (lead && hero) {
    const bits = steamPriceBits(lead, prices.get(lead.id) ?? null);
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(hero)
          .setDescription(
            [`Deal of the day: ${steamDealTitle(lead)}`, bits.percent ? `−${bits.percent}%` : '']
              .filter(Boolean)
              .join(' · ')
              .slice(0, 1024),
          ),
      ),
    );
  }

  if (top.length === 0) {
    container.addTextDisplayComponents(
      textBlock(['The shelf is empty right now. Steam is between sales.']),
    );
  }
  top.forEach((item, i) =>
    addBlock(
      container,
      steamRow(i + 1, item, prices.get(item.id) ?? null, reviews.get(item.id), extras),
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
 * Steam digest: the deal of the day's banner, then ten numbered store rows
 * with their art, price, Steam's review label, and when the sale ends.
 */
export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, SteamReviewInfo | null> = new Map(),
): V2Display {
  const top = items.slice(0, STEAM_DIGEST_SIZE);
  // Near Discord's caps the banner goes first, then the quiet lines. Prices stay.
  const tries: SteamExtras[] = [
    { hero: true, meta: true },
    { hero: false, meta: true },
    { hero: false, meta: false },
  ];
  let container = steamContainer(top, prices, reviews, tries[0]!);
  for (const extras of tries.slice(1)) {
    if (fitsV2([container])) break;
    container = steamContainer(top, prices, reviews, extras);
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/* ---------- Epic ---------- */

/** Skip a missing or zero store price. Epic still sends "$0.00" for some rows. */
export function epicWorth(price: string | undefined): string {
  const value = price?.replace(/\s+/g, ' ').trim() ?? '';
  if (!value || /^[^0-9]*0+([.,]0+)?$/.test(value)) return '';
  return value;
}

/** "$19.99" + "$24.99" → "$44.98". Empty when the currencies differ or a price is missing. */
function epicWorthTotal(games: EpicFreeGame[]): string {
  const worths = games.map((game) => epicWorth(game.originalPrice));
  if (worths.length < 2 || worths.some((worth) => !worth)) return '';
  const symbols = new Set(worths.map((worth) => worth.replace(/[\d.,\s]/g, '')));
  if (symbols.size !== 1) return '';
  const cents = worths.map(moneyToCents);
  if (cents.some((value) => value == null)) return '';
  const sum = cents.reduce<number>((total, value) => total + (value ?? 0), 0);
  const symbol = [...symbols][0] ?? '';
  const amount = (sum / 100).toFixed(2);
  return worths[0]!.trim().startsWith(symbol) ? `${symbol}${amount}` : `${amount}${symbol}`;
}

/** Title as it appears on the Epic card. Duplicate checks compare against this. */
export function epicGameTitle(game: EpicFreeGame): string {
  return linkText(game.title, 120);
}

/** The games one Epic card names: free ones first, then what comes next. */
export function selectEpicLineup(games: EpicFreeGame[]): EpicFreeGame[] {
  const current = games.filter((g) => !g.isUpcoming).slice(0, EPIC_FREE_MAX);
  const upcoming = games.filter((g) => g.isUpcoming).slice(0, EPIC_SOON_MAX);
  return [...current, ...upcoming];
}

function epicFreeRow(game: EpicFreeGame, lead: boolean): SectionBuilder | TextDisplayBuilder {
  const title = epicGameTitle(game);
  const worth = epicWorth(game.originalPrice);
  const lines = [
    `### ${linked(title, game.storeUrl)}`,
    `**🆓 FREE**${worth ? ` ~~${worth}~~` : ''}`,
  ];
  const endsIn = discordTime(game.endDate, 'R');
  const seller = linkText(game.seller ?? '', 60);
  if (lead) {
    const endsAt = discordTime(game.endDate, 'f');
    if (endsIn) lines.push(`⏳ Free until ${endsAt} · ${endsIn}`);
    const blurb = plainBlurb(game.description, 240);
    if (blurb) lines.push(`> ${blurb}`);
    if (seller) lines.push(`-# by ${seller}`);
  } else {
    const meta = [endsIn ? `⏳ ends ${endsIn}` : '', seller ? `by ${seller}` : '']
      .filter(Boolean)
      .join(' · ');
    if (meta) lines.push(`-# ${meta}`);
  }
  return artSection(lines, httpImage(game.image) ?? httpImage(game.heroImage), title, {
    label: 'Store',
    url: game.storeUrl,
  });
}

function epicSoonRow(game: EpicFreeGame): SectionBuilder | TextDisplayBuilder {
  const title = epicGameTitle(game);
  const worth = epicWorth(game.originalPrice);
  const unlocks = discordTime(game.upcomingStartDate, 'R');
  const from = discordTime(game.upcomingStartDate, 'D');
  const until = discordTime(game.endDate, 'D');
  const lines = [`### ${linked(title, game.storeUrl)}`];
  if (unlocks) lines.push(`🔓 Free ${unlocks}`);
  const meta = [from && until ? `${from} – ${until}` : '', worth ? `worth ${worth}` : '']
    .filter(Boolean)
    .join(' · ');
  if (meta) lines.push(`-# ${meta}`);
  return artSection(lines, httpImage(game.image) ?? httpImage(game.heroImage), title, {
    label: 'Store',
    url: game.storeUrl,
  });
}

/** Wide store art for each game that is free now, as one gallery. */
function epicGallery(games: EpicFreeGame[]): MediaGalleryBuilder | null {
  const gallery = new MediaGalleryBuilder();
  const seen = new Set<string>();
  for (const game of games) {
    const url = httpImage(game.heroImage) ?? httpImage(game.image);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const worth = epicWorth(game.originalPrice);
    gallery.addItems(
      new MediaGalleryItemBuilder()
        .setURL(url)
        .setDescription(
          [game.title, 'free to keep', worth ? `worth ${worth}` : '']
            .filter(Boolean)
            .join(' · ')
            .slice(0, 1024),
        ),
    );
  }
  return seen.size > 0 ? gallery : null;
}

function epicHeader(current: number, upcoming: number): TextDisplayBuilder {
  const bits: string[] = [];
  if (current > 0) bits.push(`${current} free now`);
  if (upcoming > 0) bits.push(`${upcoming} coming next`);
  return textBlock([
    `## 🎁 [Epic Free Games](${EPIC_FREE_URL})`,
    `-# ${[pragueDay(), ...bits].join(' · ')}`,
  ]);
}

function epicFooter(container: ContainerBuilder, current: EpicFreeGame[]): void {
  const total = epicWorthTotal(current);
  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      textBlock([
        total ? `💰 **${total}** worth of games, yours for nothing this week.` : '',
        `-# 🎁 ${EPIC_SHELF_MARKER} · checked daily at 12:00 and 17:00`,
      ]),
    );
  const buttons = current
    .filter((game) => game.storeUrl && game.storeUrl !== EPIC_FREE_URL)
    .slice(0, 3)
    .map((game) => linkButton(`Claim ${game.title.replace(/\s+/g, ' ').trim()}`, game.storeUrl));
  buttons.push(linkButton('All free games', EPIC_FREE_URL, '🎁'));
  container.addActionRowComponents(linkRow(buttons));
}

/**
 * Epic digest: a gallery of this week's free games, a row for each with its
 * box art and a live countdown, Claim buttons, then a quieter Coming next card.
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): V2Display {
  const lineup = selectEpicLineup(games);
  const current = lineup.filter((g) => !g.isUpcoming);
  const upcoming = lineup.filter((g) => g.isUpcoming);
  const components: ContainerBuilder[] = [];

  if (current.length > 0) {
    const free = new ContainerBuilder()
      .setAccentColor(EPIC_COLOR)
      .addTextDisplayComponents(epicHeader(current.length, upcoming.length));
    const gallery = epicGallery(current);
    if (gallery) free.addMediaGalleryComponents(gallery);
    current.forEach((game, i) => addBlock(free, epicFreeRow(game, i === 0)));
    epicFooter(free, current);
    components.push(free);

    if (upcoming.length > 0) {
      const later = new ContainerBuilder()
        .setAccentColor(EPIC_LATER_COLOR)
        .addTextDisplayComponents(textBlock(['### 🔜 Coming next', '-# Set a reminder.']));
      for (const game of upcoming) addBlock(later, epicSoonRow(game));
      components.push(later);
    }
  } else {
    const card = new ContainerBuilder()
      .setAccentColor(upcoming.length > 0 ? EPIC_LATER_COLOR : EPIC_COLOR)
      .addTextDisplayComponents(epicHeader(0, upcoming.length));
    const next = discordTime(upcoming[0]?.upcomingStartDate, 'R');
    card.addTextDisplayComponents(
      textBlock([
        upcoming.length > 0
          ? `Nothing free right now. The next drop unlocks ${next || 'soon'}.`
          : 'No free games listed right now.',
      ]),
    );
    for (const game of upcoming) addBlock(card, epicSoonRow(game));
    epicFooter(card, []);
    components.push(card);
  }

  return { components, flags: MessageFlags.IsComponentsV2 };
}

/** Linked `###` headings from a Steam or Epic card's text, in order. */
function headingTitles(blob: string): string[] {
  return [...blob.matchAll(/^###\s+[^[\n]*?\[([^\]]+)\]\(/gm)].map((m) => m[1]!.trim());
}

/** Numbered titles from a Steam digest's text, in order. */
export function extractSteamDigestTitles(blob: string): string[] {
  return [...blob.matchAll(/^\*\*\d+\.\s+\[([^\]]+)\]\(/gm)].map((m) => m[1]!.trim());
}

/** Free and upcoming titles from an Epic card's text, in order. */
export function extractEpicTitles(blob: string): string[] {
  return headingTitles(blob);
}

/** Flatten Components V2 + embeds to plain text for duplicate detection. */
export function collectMessageTextContent(message: {
  content?: string | null;
  embeds?: {
    author?: { name?: string | null } | null;
    title?: string | null;
    description?: string | null;
    fields?: { name: string; value?: string }[];
    footer?: { text?: string | null } | null;
  }[];
  components?: readonly unknown[];
}): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);

  for (const embed of message.embeds ?? []) {
    if (embed.author?.name) chunks.push(embed.author.name);
    if (embed.title) chunks.push(embed.title);
    if (embed.description) chunks.push(embed.description);
    for (const f of embed.fields ?? []) {
      chunks.push(f.name);
      if (f.value) chunks.push(f.value);
    }
    if (embed.footer?.text) chunks.push(embed.footer.text);
  }

  const walk = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    const obj = node as Record<string, unknown>;
    // Builders and received components carry the same text in `data`, getters,
    // and their JSON. Reading only the JSON keeps each line once, so a digest
    // reads back exactly the titles it shows.
    if (typeof obj.toJSON === 'function') {
      try {
        walk(obj.toJSON(), depth + 1);
      } catch {
        /* ignore */
      }
      return;
    }
    if (typeof obj.content === 'string') chunks.push(obj.content);
    if (Array.isArray(obj.components)) {
      for (const child of obj.components) walk(child, depth + 1);
    }
    if (obj.accessory) walk(obj.accessory, depth + 1);
  };

  for (const top of message.components ?? []) walk(top);
  return chunks.join('\n');
}

export function looksLikeSteamDigest(blob: string): boolean {
  return /steam daily deals|steam sales/i.test(blob);
}

export function looksLikeEpicDigest(blob: string): boolean {
  return /epic free games|epic games store/i.test(blob);
}
