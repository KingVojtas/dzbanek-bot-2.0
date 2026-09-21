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
import { formatClock, formatDuration, formatViews } from './embeds';
import type { EpicFreeGame, LoopMode, SteamDealItem, Track } from './types';

const STEAM_COLOR = 0x1b2838;
const STEAM_SPECIALS_URL = 'https://store.steampowered.com/specials';
const EPIC_COLOR = 0x2f2d2e;
const EPIC_FREE_URL = 'https://store.epicgames.com/en-US/free-games';

/** Discord V2 nested-component budget. */
const V2_COMPONENT_MAX = 40;

/**
 * Deals shown per Steam digest. Layout uses one intro + one section per game
 * (no per-row separators) so 10 games stay under Discord's 40-component cap.
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

  const lines = [
    `**${opts.label}** · ${musicSourceLabel(track.source)}`,
    titleLine,
  ];
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

function buildSteamDealSection(
  item: SteamDealItem,
  apiPrice: string | null,
  reviewStr: string | undefined,
): SectionBuilder {
  const discount = item.discount?.replace(/[()]/g, '').trim() || '';
  const priceLine = apiPrice ?? fallbackPriceLine(item);
  const title = item.gameName.slice(0, 120);

  const lines = [
    item.link ? `### [${title}](${item.link})` : `### ${title}`,
    discount ? `**${discount}**  ·  ${priceLine}` : priceLine,
  ];

  if (reviewStr) lines.push(reviewStr.slice(0, 140));

  const extras: string[] = [];
  if (item.expires) extras.push(`Until **${item.expires}**`);
  if (item.link) extras.push(`[Store →](${item.link})`);
  if (extras.length) lines.push(extras.join(' · '));

  if (item.genres) {
    lines.push(`-# ${item.genres.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  } else if (item.description) {
    const short = item.description.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (short) lines.push(`-# ${short}${item.description.length > 100 ? '…' : ''}`);
  }

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );

  const thumb = thumbnailFor(item.image, title);
  if (thumb) section.setThumbnailAccessory(thumb);
  return section;
}

/**
 * Steam digest: header + one card per deal with box-art thumbnail on the right.
 */
export function buildSteamDealsDisplay(
  items: SteamDealItem[],
  prices: Map<string, string | null>,
  reviews: Map<string, string>,
): V2Display {
  const top = items.slice(0, STEAM_DIGEST_SIZE);
  const best = topDiscountPct(top);

  const title =
    best > 0
      ? `## [Steam Daily Deals — up to ${best}% off](${STEAM_SPECIALS_URL})`
      : `## [Steam Daily Deals](${STEAM_SPECIALS_URL})`;

  const intro = [
    title,
    top.length > 0
      ? `**${top.length}** sale${top.length !== 1 ? 's' : ''} · deepest discounts first`
      : 'No deals matched the quality filter.',
    '-# Live Steam prices · Very Positive or better when available',
  ].join('\n');

  const container = new ContainerBuilder()
    .setAccentColor(STEAM_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(intro.slice(0, 4000)));

  if (top.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  }

  for (const item of top) {
    container.addSectionComponents(
      buildSteamDealSection(item, prices.get(item.id) ?? null, reviews.get(item.id)),
    );
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildEpicGameSection(game: EpicFreeGame): SectionBuilder {
  const title = game.title.slice(0, 120);
  const lines: string[] = [game.storeUrl ? `### [${title}](${game.storeUrl})` : `### ${title}`];

  if (game.isUpcoming) {
    const worth = game.originalPrice ? `Worth **${game.originalPrice}**` : 'Free soon';
    lines.push(`**Coming soon**  ·  ${worth}`);
    if (game.seller) lines.push(game.seller.slice(0, 80));

    const extras: string[] = [];
    if (game.upcomingStartDate) extras.push(`From **${epicDate(game.upcomingStartDate)}**`);
    if (game.endDate) extras.push(`Until **${epicDate(game.endDate)}**`);
    if (game.storeUrl) extras.push(`[Store →](${game.storeUrl})`);
    if (extras.length) lines.push(extras.join(' · '));
  } else {
    const priceLine = game.originalPrice ? `~~${game.originalPrice}~~ → **FREE**` : '**FREE**';
    lines.push(`**100% OFF**  ·  ${priceLine}`);
    if (game.seller) lines.push(game.seller.slice(0, 80));

    const extras: string[] = [];
    if (game.endDate) extras.push(`Until **${epicDate(game.endDate)}**`);
    if (game.storeUrl) extras.push(`[Claim →](${game.storeUrl})`);
    if (extras.length) lines.push(extras.join(' · '));
  }

  if (game.description) {
    const short = game.description.replace(/\s+/g, ' ').trim().slice(0, 110);
    if (short) lines.push(`-# ${short}${game.description.length > 110 ? '…' : ''}`);
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
  const overhead = 2 + (upcoming.length > 0 ? 2 : 0) + (current.length === 0 ? 2 : 0);
  const total = current.length + upcoming.length;
  const fit = fitRows(total, 4, overhead);
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

/**
 * Epic digest: matches the “2 Free Now / Coming next” card layout with cover art.
 */
export function buildEpicFreeGamesDisplay(games: EpicFreeGame[]): V2Display {
  const lineup = selectEpicLineup(games);
  const current = lineup.filter((g) => !g.isUpcoming);
  const upcoming = lineup.filter((g) => g.isUpcoming);

  const heading =
    current.length > 0
      ? `## [Epic Free Games — ${current.length} Free Now](${EPIC_FREE_URL})`
      : `## [Epic Free Games](${EPIC_FREE_URL})`;

  const countBits: string[] = [];
  if (current.length > 0) countBits.push(`**${current.length}** free now`);
  if (upcoming.length > 0) countBits.push(`**${upcoming.length}** coming next`);
  const subtitle =
    countBits.length > 0
      ? `${countBits.join(' · ')} · claim on the Epic Games Store`
      : 'No free games listed right now — check back soon.';

  const intro = [heading, subtitle, '-# Free to keep when claimed during the promo window.'].join(
    '\n',
  );

  const container = new ContainerBuilder()
    .setAccentColor(EPIC_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(intro.slice(0, 4000)));

  const hero = (current[0] ?? upcoming[0])?.heroImage || (current[0] ?? upcoming[0])?.image;
  if (hero) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(hero)
          .setDescription((current[0] ?? upcoming[0])!.title.slice(0, 100)),
      ),
    );
  }

  if (current.length > 0) {
    for (const game of current) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addSectionComponents(buildEpicGameSection(game));
    }
  } else {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '### This week\n🕐 Nothing free right now — see upcoming below or check the store.',
      ),
    );
  }

  if (upcoming.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🔜 **Coming next** · ${upcoming.length} title${upcoming.length === 1 ? '' : 's'}`,
      ),
    );
    for (const game of upcoming) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addSectionComponents(buildEpicGameSection(game));
    }
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
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
  for (const m of blob.matchAll(/###\s+\[([^\]]+)\]|###\s+([^\n]+)/g)) {
    const t = (m[1] ?? m[2] ?? '').trim();
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
