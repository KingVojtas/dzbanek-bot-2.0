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
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { formatClock, formatDuration, formatViews } from './embeds';
import type { EpicFreeGame, LoopMode, SteamDealItem, Track } from './types';

const STEAM_COLOR = 0x66c0f4;
const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_COLOR = 0x26bbff;
const EPIC_LATER_COLOR = 0x8b93a7;
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/** Discord V2 nested-component budget. */
const V2_COMPONENT_MAX = 40;

/**
 * Deals shown per Steam digest. One hero, one intro, ten thumbnail rows, and
 * a link button stay under Discord's 40-component cap. No per-row separators.
 */
export const STEAM_DIGEST_SIZE = 10;
const EPIC_DIGEST_MAX = 6;

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

export interface NowPlayingDisplayOptions {
  track: Track;
  queueLength: number;
  paused: boolean;
  loopMode: LoopMode;
  positionSec?: number;
  upNextTitle?: string | null;
  label?: string;
  footer?: string;
}

/** Live Now Playing panel: album art, metadata, transport controls. */
export function buildNowPlayingDisplay(opts: NowPlayingDisplayOptions): V2Display {
  const { track, queueLength, paused, loopMode } = opts;
  const positionSec = Math.max(0, opts.positionSec ?? 0);
  const durationSec = track.durationSec > 0 ? track.durationSec : 0;
  const artist = (track.uploader ?? 'Unknown artist').slice(0, 80);
  const label = opts.label ?? (paused ? 'Paused' : 'Now Playing');
  const linkUrl = track.sourceUrl || track.url;
  const titleLine = linkUrl
    ? `### [${track.title.slice(0, 200)}](${linkUrl})`
    : `### ${track.title.slice(0, 200)}`;
  const loopLabel =
    loopMode === 'track' ? '🔁 Track' : loopMode === 'queue' ? '🔁 Queue' : '🔁 Off';

  const meta: string[] = [`\`${formatDuration(track.durationSec)}\``];
  if (track.requestedBy) meta.push(track.requestedBy);
  const views = formatViews(track.views);
  if (views) meta.push(views);

  const body = [
    `**${label}** · ${musicSourceLabel(track.source)}`,
    titleLine,
    `*${artist}*`,
    '',
    `\`${progressBar(positionSec, durationSec)}\``,
    `\`${formatClock(positionSec)}\`  /  \`${durationSec > 0 ? formatClock(durationSec) : 'Live'}\``,
    '',
    meta.join(' · '),
    `Queue **${queueLength}** · ${loopLabel}`,
  ];

  if (opts.upNextTitle) {
    body.push(`-# ⏭ Up next: **${opts.upNextTitle.slice(0, 80)}**`);
  } else if (opts.footer) {
    body.push(`-# ${opts.footer}`);
  } else if (track.source === 'spotify') {
    body.push('-# Audio matched on YouTube · metadata from Spotify');
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(body.join('\n').slice(0, 4000)),
  );
  const thumb = thumbnailFor(track.thumbnail, track.title);
  if (thumb) section.setThumbnailAccessory(thumb);

  const transport = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(paused ? 'music:resume' : 'music:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(ButtonStyle.Primary),
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
      .setEmoji('🔁')
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
  );

  const container = new ContainerBuilder().setAccentColor(musicAccent(track.source));

  if (track.thumbnail && /^https?:\/\//i.test(track.thumbnail)) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(track.thumbnail)
          .setDescription(track.title.slice(0, 100)),
      ),
    );
  }

  container
    .addSectionComponents(section)
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(transport);

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
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

function topDiscountPct(items: SteamDealItem[]): number {
  return items.reduce((max, item) => {
    if (!item.discount) return max;
    const n = parseInt(item.discount.replace(/\D/g, ''), 10);
    return !Number.isNaN(n) && n > max ? n : max;
  }, 0);
}

function fallbackPriceLine(item: SteamDealItem): string {
  if (item.salePrice && item.originalPrice) {
    return `~~${item.originalPrice}~~ → **${item.salePrice}**`;
  }
  if (item.salePrice) return `**${item.salePrice}**`;
  if (item.originalPrice) return item.originalPrice;
  return 'See store';
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

function fitRows(desired: number, perRow: number, overhead: number): number {
  if (desired <= 0) return 0;
  let n = desired;
  while (n > 1 && overhead + n * perRow > V2_COMPONENT_MAX) n -= 1;
  return n;
}

function thumbnailFor(url: string | undefined, alt: string): ThumbnailBuilder | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return new ThumbnailBuilder().setURL(url).setDescription(alt.slice(0, 100));
}

function httpImage(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

function discountLabel(item: SteamDealItem, apiPrice: string | null): string {
  const fromPrice = apiPrice?.match(/\((-?\d+)%\)\s*$/)?.[1];
  const raw = item.discount ?? fromPrice ?? '';
  const n = parseInt(String(raw).replace(/\D/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `-${n}%`;
}

/** Drop the trailing percent. The row already leads with a discount badge. */
function tidyPrice(price: string): string {
  return price.replace(/\s*\(-?\d+%\)\s*$/, '').trim();
}

function priceParts(price: string): { pay: string; was: string } {
  return {
    pay: price.match(/\*\*([^*]+)\*\*/)?.[1]?.trim() ?? '',
    was: price.match(/~~([^~]+)~~/)?.[1]?.trim() ?? '',
  };
}

const ANSI = '\u001b';

/** Gray struck-through price inside an ANSI chip. Markdown strike does not render there. */
function strikeAnsi(value: string): string {
  return [...value].map((ch) => (ch === ' ' ? ch : `${ch}\u0336`)).join('');
}

/**
 * Steam discount block: lime percent on green, muted original, bright sale price.
 * The featured row pads the percent so it still leads.
 */
function steamPriceChip(discount: string, pay: string, was: string, featured: boolean): string {
  const pad = featured ? '  ' : ' ';
  const bits = [`${ANSI}[1;92;42m${pad}${discount}${pad}${ANSI}[0m`];
  if (was) bits.push(`${ANSI}[0;90m${strikeAnsi(was)}${ANSI}[0m`);
  if (pay) bits.push(`${ANSI}[1;97m${pay}${ANSI}[0m`);
  return `\`\`\`ansi\n${bits.join(' ')}\n\`\`\``;
}

/** Masthead sale banner. Same green as the per-game percent. */
function steamGreenBadge(label: string): string {
  return `\`\`\`ansi\n${ANSI}[1;92;42m  ${label}  ${ANSI}[0m\n\`\`\``;
}

/** Green discount chip when the game is on sale. Plain markdown prices otherwise. */
function shelfMoney(discount: string, price: string, featured: boolean): string[] {
  const { pay, was } = priceParts(price);
  if (discount) {
    const chip = steamPriceChip(discount, pay, was, featured);
    if (!pay && !was && price) return [chip, price];
    return [chip];
  }
  if (!pay && !was) return price ? [price] : [];
  const cost = [pay ? `**${pay}**` : '', was ? `~~${was}~~` : ''].filter(Boolean).join('  ·  ');
  return cost ? [cost] : [];
}

function dealBlurb(value: string | undefined, limit = 150): string {
  if (!value) return '';
  const text = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > 80 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

function shelfDate(): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Prague',
  }).format(new Date());
}

function prettyExpiry(value: string): string {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return value.replace(/\s+/g, ' ').trim();
  const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const thisYear = new Date().getUTCFullYear();
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: date.getUTCFullYear() === thisYear ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

function buildSteamDealSection(
  item: SteamDealItem,
  index: number,
  apiPrice: string | null,
  reviewStr: string | undefined,
): SectionBuilder {
  const title = item.gameName.replace(/\s+/g, ' ').trim().slice(0, 80);
  const name = item.link ? `[${title}](${item.link})` : title;
  const discount = discountLabel(item, apiPrice);
  const price = tidyPrice(apiPrice ?? fallbackPriceLine(item));
  const lead = index === 0;

  const lines = [
    lead ? `### ${name}` : `### ${index + 1} · ${name}`,
    ...shelfMoney(discount, price, lead),
  ];

  const meta: string[] = [];
  if (reviewStr) meta.push(reviewStr.slice(0, 80));
  if (item.expires) meta.push(`until ${prettyExpiry(item.expires)}`);
  if (meta.length) lines.push(meta.join('  ·  '));

  const blurb = dealBlurb(item.description);
  if (blurb) lines.push(blurb);
  else {
    const genres = item.genres?.replace(/\s+/g, ' ').trim();
    if (genres) lines.push(`-# ${genres.slice(0, 80)}`);
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );

  const thumbUrl = httpImage(item.image);
  const banner = lead ? (httpImage(item.heroImage) ?? thumbUrl) : undefined;
  const thumb = banner && thumbUrl === banner ? null : thumbnailFor(thumbUrl, title);
  if (thumb) section.setThumbnailAccessory(thumb);
  else if (item.link) {
    section.setButtonAccessory(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Store').setURL(item.link),
    );
  }
  return section;
}

/**
 * Steam digest: masthead, a wide banner of the top cut, that deal, then the
 * other nine. Every image URL has already been checked.
 */
export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, string>,
): V2Display {
  const top = items.slice(0, STEAM_DIGEST_SIZE);
  const best = topDiscountPct(top);
  const heroItem = top[0];
  const hero = heroItem ? (httpImage(heroItem.heroImage) ?? httpImage(heroItem.image)) : undefined;
  const heroPrice = heroItem
    ? tidyPrice(prices.get(heroItem.id) ?? fallbackPriceLine(heroItem))
    : '';
  const heroPay = priceParts(heroPrice).pay;
  const heroDiscount = heroItem ? discountLabel(heroItem, prices.get(heroItem.id) ?? null) : '';

  const intro = [
    `## [Steam Daily Deals](${STEAM_SPECIALS_URL})`,
    top.length === 0
      ? 'The shelf is empty right now.'
      : best > 0
        ? steamGreenBadge(`Up to ${best}% off`)
        : '',
    top.length === 0
      ? `-# ${shelfDate()} · Big releases first · EUR on the German store`
      : `-# ${shelfDate()} · ${top.length} on the shelf · Big releases first · EUR on the German store`,
  ]
    .filter(Boolean)
    .join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(STEAM_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(intro.slice(0, 4000)));

  if (hero && heroItem) {
    const caption = [heroItem.gameName, heroDiscount, heroPay].filter(Boolean).join(' · ');
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(hero).setDescription(caption.slice(0, 100)),
      ),
    );
  } else if (top.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large),
    );
  }

  top.forEach((item, index) => {
    if (index === 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
    }
    container.addSectionComponents(
      buildSteamDealSection(item, index, prices.get(item.id) ?? null, reviews.get(item.id)),
    );
  });

  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Browse specials')
          .setEmoji('💸')
          .setURL(STEAM_SPECIALS_URL),
      ),
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
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

/** White FREE on Epic blue, then the struck store price in gray. */
function epicFreeChip(was: string, featured: boolean): string {
  const pad = featured ? '  ' : ' ';
  const bits = [`${ANSI}[1;97;44m${pad}FREE${pad}${ANSI}[0m`];
  if (was) bits.push(`${ANSI}[0;90m${strikeAnsi(was)}${ANSI}[0m`);
  return `\`\`\`ansi\n${bits.join(' ')}\n\`\`\``;
}

/** Masthead and upcoming status. Blue for what you can claim, gray for later. */
function epicBadge(label: string, tone: 'blue' | 'muted'): string {
  const color = tone === 'blue' ? '1;97;44' : '1;37;100';
  return `\`\`\`ansi\n${ANSI}[${color}m  ${label}  ${ANSI}[0m\n\`\`\``;
}

function epicKicker(current: number, upcoming: number): string {
  const bits = ['Yours to keep once claimed'];
  if (current > 0) bits.push(`${current} free now`);
  if (upcoming > 0) bits.push(`${upcoming} coming next`);
  if (current === 0 && upcoming === 0) bits.push('check the store');
  return `-# ${bits.join(' · ')}`;
}

function epicGallery(games: EpicFreeGame[], limit: number): MediaGalleryBuilder | null {
  const gallery = new MediaGalleryBuilder();
  const seen = new Set<string>();
  for (const game of games) {
    const url = httpImage(game.heroImage) ?? httpImage(game.image);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const worth = epicWorth(game.originalPrice);
    const tag = game.isUpcoming ? 'Coming soon' : 'FREE';
    gallery.addItems(
      new MediaGalleryItemBuilder()
        .setURL(url)
        .setDescription([game.title, tag, worth].filter(Boolean).join(' · ').slice(0, 100)),
    );
    if (seen.size >= limit) break;
  }
  return seen.size > 0 ? gallery : null;
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

function buildEpicGameSection(game: EpicFreeGame, lead: boolean): SectionBuilder {
  const title = game.title.replace(/\s+/g, ' ').trim().slice(0, 120);
  const lines: string[] = [game.storeUrl ? `### [${title}](${game.storeUrl})` : `### ${title}`];
  const worth = epicWorth(game.originalPrice);

  if (game.isUpcoming) {
    lines.push(epicBadge('SOON', 'muted'));
    const meta: string[] = [];
    if (worth) meta.push(`Worth **${worth}**`);
    const freeAt = discordWhen(game.upcomingStartDate, 'R');
    const through = discordWhen(game.endDate, 'D');
    if (freeAt) meta.push(`free ${freeAt}`);
    if (through) meta.push(`through ${through}`);
    if (meta.length) lines.push(meta.join('  ·  '));
  } else {
    lines.push(epicFreeChip(worth, lead));
    const endRel = discordWhen(game.endDate, 'R');
    const endDate = lead ? discordWhen(game.endDate, 'D') : '';
    const when = [endRel ? `Ends ${endRel}` : '', endDate].filter(Boolean).join('  ·  ');
    if (when) lines.push(when);
  }

  const seller = game.seller?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? '';
  const blurb = dealBlurb(game.description, lead ? 240 : 120);
  if (lead) {
    if (seller) lines.push(seller);
    if (blurb) lines.push(blurb);
  } else {
    const quiet = [seller, blurb].filter(Boolean).join(' · ');
    if (quiet) lines.push(`-# ${quiet.slice(0, 200)}`);
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );
  const thumb = thumbnailFor(game.image, title);
  if (thumb) section.setThumbnailAccessory(thumb);
  return section;
}

function selectEpicLineup(games: EpicFreeGame[]): EpicFreeGame[] {
  const freeAll = games.filter((g) => !g.isUpcoming);
  const upcomingAll = games.filter((g) => g.isUpcoming);
  let current = freeAll.slice(0, Math.min(freeAll.length, EPIC_DIGEST_MAX));
  let upcoming = upcomingAll.slice(0, Math.max(0, EPIC_DIGEST_MAX - current.length));
  // Free card: container, intro, two gallery items, divider, button row, two buttons.
  // Later card: container, header, one gallery item. Upcoming-only uses one larger card.
  const overhead =
    (current.length > 0 ? 9 : 0) + (upcoming.length > 0 ? (current.length > 0 ? 4 : 8) : 0);
  const total = current.length + upcoming.length;
  const fit = fitRows(total, 3, overhead);
  if (fit < total) {
    const drop = total - fit;
    if (upcoming.length >= drop) upcoming = upcoming.slice(0, upcoming.length - drop);
    else {
      const rest = drop - upcoming.length;
      upcoming = [];
      current = current.slice(0, Math.max(1, current.length - rest));
    }
  }
  return [...current, ...upcoming];
}

function epicIntro(current: number, upcoming: number, badge: string): string {
  return [`## [Epic Free Games](${EPIC_FREE_URL})`, badge, epicKicker(current, upcoming)]
    .filter(Boolean)
    .join('\n');
}

function addEpicFooter(container: ContainerBuilder, claim: EpicFreeGame | undefined): void {
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(epicActionRow(claim));
}

/**
 * Epic digest: a blue Free Now card, then a quieter Coming next card.
 * Each offer carries a live countdown and the store's FREE chip.
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): V2Display {
  const lineup = selectEpicLineup(games);
  const current = lineup.filter((g) => !g.isUpcoming);
  const upcoming = lineup.filter((g) => g.isUpcoming);
  const components: ContainerBuilder[] = [];

  if (current.length > 0) {
    const free = new ContainerBuilder()
      .setAccentColor(EPIC_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          epicIntro(current.length, upcoming.length, epicBadge('FREE NOW', 'blue')).slice(0, 4000),
        ),
      );
    const gallery = epicGallery(current, 2);
    if (gallery) free.addMediaGalleryComponents(gallery);
    current.forEach((game, index) =>
      free.addSectionComponents(buildEpicGameSection(game, index === 0)),
    );
    addEpicFooter(free, current[0]);
    components.push(free);
  }

  if (upcoming.length > 0 && current.length > 0) {
    const later = new ContainerBuilder()
      .setAccentColor(EPIC_LATER_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          ['## Coming next', `-# ${upcoming.length} title${upcoming.length === 1 ? '' : 's'}`].join(
            '\n',
          ),
        ),
      );
    const gallery = epicGallery(upcoming, 1);
    if (gallery) later.addMediaGalleryComponents(gallery);
    for (const game of upcoming) later.addSectionComponents(buildEpicGameSection(game, false));
    components.push(later);
  } else if (upcoming.length > 0) {
    const later = new ContainerBuilder()
      .setAccentColor(EPIC_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            epicIntro(0, upcoming.length, epicBadge('COMING SOON', 'muted')),
            'Nothing free right now.',
          ].join('\n'),
        ),
      );
    const gallery = epicGallery(upcoming, 1);
    if (gallery) later.addMediaGalleryComponents(gallery);
    for (const game of upcoming) later.addSectionComponents(buildEpicGameSection(game, false));
    addEpicFooter(later, undefined);
    components.push(later);
  }

  if (components.length === 0) {
    const empty = new ContainerBuilder()
      .setAccentColor(EPIC_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [epicIntro(0, 0, ''), 'No free games listed right now.']
            .filter(Boolean)
            .join('\n')
            .slice(0, 4000),
        ),
      );
    addEpicFooter(empty, undefined);
    components.push(empty);
  }

  return { components, flags: MessageFlags.IsComponentsV2 };
}

/** Flatten Components V2 + legacy embeds to plain text for duplicate detection. */
export function collectMessageTextContent(message: {
  content?: string | null;
  embeds?: { title?: string | null; description?: string | null; fields?: { name: string }[] }[];
  components?: readonly unknown[];
}): string {
  const chunks: string[] = [];
  if (message.content) chunks.push(message.content);

  for (const embed of message.embeds ?? []) {
    if (embed.title) chunks.push(embed.title);
    if (embed.description) chunks.push(embed.description);
    for (const f of embed.fields ?? []) chunks.push(f.name);
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

export function extractHeadingTitles(blob: string): string[] {
  const titles: string[] = [];
  for (const m of blob.matchAll(
    /###\s+(?:\d+\s*·\s*)?\[([^\]]+)\]|###\s+(?:\d+\s*·\s*)?([^\n]+)/g,
  )) {
    const t = (m[1] ?? m[2] ?? '').replace(/^\d+\s*·\s*/, '').trim();
    if (t && !/^coming next/i.test(t) && t !== 'This week') titles.push(t);
  }
  return titles;
}

export function looksLikeSteamDigest(blob: string): boolean {
  return /steam daily deals|steam sales/i.test(blob);
}

export function looksLikeEpicDigest(blob: string): boolean {
  return /epic free games/i.test(blob);
}
