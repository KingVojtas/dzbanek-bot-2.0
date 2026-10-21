import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { isGoodReview, type SteamReviewInfo } from '../deals/steam/SteamReviewApi';
import {
  QUEUE_PAGE_SIZE,
  SITE_CLAY,
  SITE_EPIC,
  SITE_STEAM,
  buildSiteEmbed,
  formatClock,
  formatDuration,
  queueTotalPages,
  upcomingQueue,
  type EmbedCard,
} from './embeds';
import type { EpicFreeGame, LoopMode, SteamDealItem, Track } from './types';

const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/** Games per Steam digest. */
export const STEAM_DIGEST_SIZE = 10;

/** In the current Steam card's footer. An older card without it still needs a refresh. */
export const STEAM_SHELF_MARKER = 'prices in €';
const EPIC_DIGEST_MAX = 6;

/** Components V2 message, for the cards the website does not show. */
export interface V2Display {
  components: ContainerBuilder[];
  flags: typeof MessageFlags.IsComponentsV2;
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
}

/** Now Playing card, as on the website: who asked, the clock, the transport row. */
export function buildNowPlayingDisplay(opts: NowPlayingDisplayOptions): EmbedCard {
  const { track, queueLength, paused, loopMode } = opts;
  const positionSec = Math.max(0, opts.positionSec ?? 0);
  const durationSec = track.durationSec > 0 ? track.durationSec : 0;
  const requester = track.requestedById ? `<@${track.requestedById}>` : track.requestedBy;
  const volume = opts.volume ?? 1;
  const volumePct = Math.round(volume * 100);

  const description = [
    `Requested by ${requester} · ${musicSourceLabel(track.source)}`,
    `\`${formatClock(positionSec)}\` ${progressBar(positionSec, durationSec)} \`${
      durationSec > 0 ? formatClock(durationSec) : 'Live'
    }\``,
  ].join('\n');
  const footer = [upNextLine(queueLength)];
  if (volumePct !== 100) footer.push(`Volume ${volumePct}%`);

  const embed = buildSiteEmbed({
    color: SITE_CLAY,
    author: paused ? '⏸️ Paused' : '🔊 Now Playing',
    title: track.title,
    url: track.sourceUrl || track.url,
    description,
    footer: footer.join(' · '),
    thumbnail: track.thumbnail,
  });

  const transport = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(paused ? 'music:resume' : 'music:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setLabel(loopMode === 'off' ? 'Loop' : loopMode === 'track' ? 'Repeat' : 'Queue')
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setLabel('Shuffle')
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
    lines.push(`Now: **${linked(title, current.sourceUrl || current.url)}**`, '');
  }
  if (pageTracks.length > 0) {
    pageTracks.forEach((track, i) => {
      const title = linkText(track.title, 80);
      lines.push(
        `${start + i + 1}. ${linked(title, track.sourceUrl || track.url)} \`${formatDuration(track.durationSec)}\``,
      );
    });
  } else {
    lines.push('– Nothing up next');
  }

  const embed = buildSiteEmbed({
    color: SITE_CLAY,
    author: '📜 Queue',
    description: lines.join('\n'),
    footer: `Page ${safePage + 1} of ${totalPages} · ${upNextLine(upcoming.length)}`,
  });

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${safePage - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${safePage + 1}`)
      .setLabel('Next ▶')
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
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return new ThumbnailBuilder().setURL(url).setDescription(alt.slice(0, 100));
}

function httpImage(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

function fallbackPriceLine(item: SteamDealItem): string {
  if (item.salePrice && item.originalPrice) {
    return `~~${item.originalPrice}~~ → **${item.salePrice}**`;
  }
  if (item.salePrice) return `**${item.salePrice}**`;
  if (item.originalPrice) return item.originalPrice;
  return '';
}

function discountLabel(item: SteamDealItem, apiPrice: string | null): string {
  const fromPrice = apiPrice?.match(/\((-?\d+)%\)\s*$/)?.[1];
  const raw = item.discount ?? fromPrice ?? '';
  const n = parseInt(String(raw).replace(/\D/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `−${n}%`;
}

function priceParts(price: string): { pay: string; was: string } {
  return {
    pay: price.match(/\*\*([^*]+)\*\*/)?.[1]?.trim() ?? '',
    was: price.match(/~~([^~]+)~~/)?.[1]?.trim() ?? '',
  };
}

/** The website's chip: Steam's own review label for a well-reviewed game, otherwise Special. */
function steamChip(review: SteamReviewInfo | null | undefined): string {
  return review && isGoodReview(review) && review.scoreDesc ? review.scoreDesc : 'Special';
}

/** Title as it appears in a digest row. Duplicate checks compare against this. */
export function steamDealTitle(item: SteamDealItem): string {
  return linkText(item.gameName, 80);
}

function steamDealLine(
  n: number,
  item: SteamDealItem,
  apiPrice: string | null,
  review: SteamReviewInfo | null | undefined,
): string {
  const name = linked(steamDealTitle(item), item.link);
  const discount = discountLabel(item, apiPrice);
  const { pay, was } = priceParts(apiPrice ?? fallbackPriceLine(item));
  const money = [
    discount ? `\`${discount}\`` : '',
    was ? `~~${was}~~` : '',
    pay ? `**${pay}**` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return [`${n}. ${name}`, steamChip(review), money].filter(Boolean).join(' · ');
}

function pragueClock(): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Prague',
  }).format(new Date());
}

/** Numbered titles from a Steam digest's text, in order. */
export function extractSteamDigestTitles(blob: string): string[] {
  return [...blob.matchAll(/^\d+\.\s+\[([^\]]+)\]/gm)].map((m) => m[1]!.trim());
}

/**
 * Steam digest, as on the website: one numbered line per game with its review
 * chip, discount, and euro price.
 */
export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, SteamReviewInfo | null> = new Map(),
): EmbedCard {
  const top = items.slice(0, STEAM_DIGEST_SIZE);
  const lines = top.map((item, i) =>
    steamDealLine(i + 1, item, prices.get(item.id) ?? null, reviews.get(item.id)),
  );

  const embed = buildSiteEmbed({
    color: SITE_STEAM,
    author: `Steam · ${pragueClock()}`,
    title: 'Steam Daily Deals',
    url: STEAM_SPECIALS_URL,
    description: lines.length > 0 ? lines.join('\n') : 'The shelf is empty right now.',
    footer: `${top.length} game${top.length === 1 ? '' : 's'} · ${STEAM_SHELF_MARKER}`,
  });

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Browse specials')
      .setEmoji('💸')
      .setURL(STEAM_SPECIALS_URL),
  );

  return { embeds: [embed], components: [row] };
}

function epicDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

/** Skip a missing or zero store price. Epic still sends "$0.00" for some rows. */
function epicWorth(price: string | undefined): string {
  const value = price?.replace(/\s+/g, ' ').trim() ?? '';
  if (!value || /^[^0-9]*0+([.,]0+)?$/.test(value)) return '';
  return value;
}

/** Live countdown. Falls back to a plain date when the store time is unreadable. */
function discordWhen(iso: string | undefined, style: 'R' | 'D'): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return epicDate(iso);
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function dealBlurb(value: string | undefined, limit = 150): string {
  if (!value) return '';
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`[\]~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > 80 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

function claimLabel(title: string): string {
  const label = `Claim ${title.replace(/\s+/g, ' ').trim()}`;
  return label.length <= 80 ? label : `${label.slice(0, 79).trimEnd()}…`;
}

function epicActionRow(
  claim: EpicFreeGame | undefined,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  if (claim?.storeUrl && claim.storeUrl !== EPIC_FREE_URL) {
    row.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(claimLabel(claim.title))
        .setURL(claim.storeUrl),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Browse free games')
      .setEmoji('🎁')
      .setURL(EPIC_FREE_URL),
  );
  return row;
}

/** Title as it appears on the Epic card. Duplicate checks compare against this. */
export function epicGameTitle(game: EpicFreeGame): string {
  return linkText(game.title, 120);
}

function epicFreeLine(game: EpicFreeGame): string {
  const worth = epicWorth(game.originalPrice);
  const ends = discordWhen(game.endDate, 'R');
  return [
    `**${linked(epicGameTitle(game), game.storeUrl)}**`,
    [worth ? `~~${worth}~~` : '', '**Free**'].filter(Boolean).join(' '),
    ends ? `ends ${ends}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function epicSoonLine(game: EpicFreeGame): string {
  const freeAt = discordWhen(game.upcomingStartDate, 'R');
  return [`**${linked(epicGameTitle(game), game.storeUrl)}**`, freeAt ? `free ${freeAt}` : '']
    .filter(Boolean)
    .join(' · ');
}

/** The games one Epic card names: free ones first, then what comes next. */
export function selectEpicLineup(games: EpicFreeGame[]): EpicFreeGame[] {
  const current = games.filter((g) => !g.isUpcoming).slice(0, EPIC_DIGEST_MAX);
  const upcoming = games.filter((g) => g.isUpcoming).slice(0, EPIC_DIGEST_MAX);
  return [...current, ...upcoming];
}

/** Bold linked titles from an Epic card's text, in order. */
export function extractEpicTitles(blob: string): string[] {
  return [...blob.matchAll(/\*\*\[([^\]]+)\]\(/g)].map((m) => m[1]!.trim());
}

/**
 * Epic card, as on the website: what is free now with its cover, and a quieter
 * Coming next field.
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): EmbedCard {
  const lineup = selectEpicLineup(games);
  const current = lineup.filter((g) => !g.isUpcoming);
  const upcoming = lineup.filter((g) => g.isUpcoming);
  const lead = current[0] ?? upcoming[0];

  const lines = current.map(epicFreeLine);
  const blurb = dealBlurb(current[0]?.description, 240);
  if (blurb) lines.push('', `*${blurb}*`);
  if (current.length === 0) {
    lines.push(upcoming.length > 0 ? 'Nothing free right now.' : 'No free games listed right now.');
  }

  const embed = buildSiteEmbed({
    color: SITE_EPIC,
    author: 'Epic Games Store',
    title: current.length === 0 && upcoming.length > 0 ? 'Coming soon' : 'Free now',
    url: EPIC_FREE_URL,
    description: lines.join('\n'),
    fields:
      upcoming.length > 0 ? [['Coming next', upcoming.map(epicSoonLine).join('\n'), true]] : [],
    footer: 'Yours to keep once claimed',
    image: httpImage(lead?.heroImage) ?? httpImage(lead?.image),
  });

  return { embeds: [embed], components: [epicActionRow(current[0])] };
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
    if (typeof obj.content === 'string') chunks.push(obj.content);
    if (typeof obj.toJSON === 'function') {
      try {
        walk(obj.toJSON(), depth + 1);
      } catch {
        /* ignore */
      }
    }
    if (obj.data && typeof obj.data === 'object') walk(obj.data, depth + 1);
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
