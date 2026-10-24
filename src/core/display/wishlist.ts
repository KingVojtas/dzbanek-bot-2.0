import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { SITE_STEAM } from '../embeds';
import type { SteamDealItem } from '../types';
import { steamDealTitle, steamMoneyLine, steamPriceBits, steamSaleEnds } from './steam';
import { euros, linked, moneyToCents } from './text';
import {
  addBlock,
  artSection,
  divider,
  fitsV2,
  httpImage,
  linkButton,
  linkRow,
  textBlock,
  type V2Display,
} from './v2';

/** A wishlisted game on sale, with Steam's live price line (`formatSteamPrice`). */
export interface WishlistGame {
  item: SteamDealItem;
  price: string | null;
}

export interface WishlistRadarView {
  /** On sale and wishlisted by two or more members. */
  together: { game: WishlistGame; userIds: string[] }[];
  /** Each member's hits, deepest discount first. */
  people: { userId: string; games: WishlistGame[] }[];
}

const RADAR_COLOR = 0x5dd39e;

/** In the radar card's footer. Also how a radar card is told apart from the digest. */
export const RADAR_MARKER = 'Wishlist Radar';

function radarLine(game: WishlistGame): string {
  const money = steamMoneyLine(steamPriceBits(game.item, game.price), false);
  const ends = steamSaleEnds(game.item.expires);
  return [`**${linked(steamDealTitle(game.item), game.item.link)}**`, money, ends]
    .filter(Boolean)
    .join(' · ');
}

interface RadarLimits {
  together: number;
  perPerson: number;
}

function radarContainer(view: WishlistRadarView, limits: RadarLimits): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(RADAR_COLOR);
  const together = view.together.slice(0, limits.together);
  if (together.length > 0) {
    container.addTextDisplayComponents(textBlock(['### 🤝 Wanted together']));
    for (const { game, userIds } of together) {
      const title = steamDealTitle(game.item);
      const ends = steamSaleEnds(game.item.expires);
      addBlock(
        container,
        artSection(
          [
            `**${linked(title, game.item.link)}**`,
            steamMoneyLine(steamPriceBits(game.item, game.price), false),
            `-# ${[`🤝 ${userIds.map((id) => `<@${id}>`).join(', ')}`, ends].filter(Boolean).join(' · ')}`,
          ],
          httpImage(game.item.image),
          title,
          { label: 'Store', url: game.item.link },
        ),
      );
    }
    container.addSeparatorComponents(divider());
  }

  for (const person of view.people) {
    if (person.games.length === 0) continue;
    const shown = person.games.slice(0, limits.perPerson);
    const more = person.games.length - shown.length;
    container.addTextDisplayComponents(
      textBlock([
        `🎯 **For <@${person.userId}>**`,
        ...shown.map((game) => `- ${radarLine(game)}`),
        more > 0 ? `-# and ${more} more · /steam wishlist` : '',
      ]),
    );
  }

  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      textBlock([
        `-# 🎯 ${RADAR_MARKER} · games on your Steam wishlist that are on sale · /steam link to join`,
      ]),
    );
  return container;
}

/**
 * Wishlist Radar: games two or more members want, with their art, then each
 * member's own sale hits as compact lines. Shortens to fit Discord's caps.
 */
export function buildWishlistRadarDisplay(view: WishlistRadarView, perPerson = 5): V2Display {
  const tries: RadarLimits[] = [
    { together: 4, perPerson },
    { together: 4, perPerson: Math.min(perPerson, 3) },
    { together: 2, perPerson: Math.min(perPerson, 2) },
    { together: 0, perPerson: 1 },
  ];
  let container = radarContainer(view, tries[0]!);
  for (const limits of tries.slice(1)) {
    if (fitsV2([container])) break;
    container = radarContainer(view, limits);
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/* ---------- /steam wishlist ---------- */

/**
 * `sale` is discounted now, `price` is at full price, `free` is free to play,
 * `soon` is not out yet, `gone` is no longer sold on Steam.
 */
export type WishlistShelfKind = 'sale' | 'price' | 'free' | 'soon' | 'gone';

export interface WishlistShelfEntry {
  item: SteamDealItem;
  kind: WishlistShelfKind;
  /** `formatSteamPrice` output for a sale; null otherwise (`item.salePrice` holds a full price). */
  price: string | null;
  /** Release note for `soon`: "To be announced", "Q4 2026", a date. */
  note?: string;
}

export const WISHLIST_PAGE_SIZE = 10;

/** Page buttons on the private wishlist card. `steamwish:page:0` is the first page. */
export const WISHLIST_BUTTON_PREFIX = 'steamwish:page:';

function wishlistRow(entry: WishlistShelfEntry): SectionBuilder | TextDisplayBuilder {
  const { item } = entry;
  const title = steamDealTitle(item);
  const lines = [`**${linked(title, item.link)}**`];
  if (entry.kind === 'sale') {
    lines.push(steamMoneyLine(steamPriceBits(item, entry.price), false));
    const ends = steamSaleEnds(item.expires);
    if (ends) lines.push(`-# ${ends}`);
  } else if (entry.kind === 'price') {
    lines.push(`**${item.salePrice ?? ''}**`, '-# Not on sale');
  } else if (entry.kind === 'free') {
    lines.push('**Free to play**');
  } else if (entry.kind === 'soon') {
    lines.push('🗓️ **Coming soon**');
    if (entry.note) lines.push(`-# ${entry.note}`);
  } else {
    lines.push('-# Not sold on Steam right now');
  }
  return artSection(lines, httpImage(item.image), title, { label: 'Store', url: item.link });
}

/**
 * Your whole Steam wishlist, ten games a page: sales first with the struck
 * price, then full-price games, free ones, what is coming, and what is gone.
 */
export function buildWishlistDisplay(
  entries: WishlistShelfEntry[],
  page: number,
  steamId: string,
): V2Display {
  const totalPages = Math.max(1, Math.ceil(entries.length / WISHLIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const shown = entries.slice(safePage * WISHLIST_PAGE_SIZE, (safePage + 1) * WISHLIST_PAGE_SIZE);

  const sales = entries.filter((entry) => entry.kind === 'sale');
  let saved = 0;
  for (const entry of sales) {
    const bits = steamPriceBits(entry.item, entry.price);
    const was = moneyToCents(bits.was);
    const pay = moneyToCents(bits.pay);
    if (was != null && pay != null && was > pay) saved += was - pay;
  }
  const summary = [
    `${entries.length} game${entries.length === 1 ? '' : 's'}`,
    sales.length > 0 ? `**${sales.length} on sale**` : 'nothing on sale right now',
    saved > 0 ? `the sales save ${euros(saved)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const container = new ContainerBuilder()
    .setAccentColor(sales.length > 0 ? RADAR_COLOR : SITE_STEAM)
    .addTextDisplayComponents(textBlock(['**🎯 Your Steam wishlist**', `-# ${summary}`]))
    .addSeparatorComponents(divider());
  for (const entry of shown) addBlock(container, wishlistRow(entry));

  const buttons: ButtonBuilder[] = [];
  if (totalPages > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${WISHLIST_BUTTON_PREFIX}${safePage - 1}`)
        .setLabel('Prev')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(`${WISHLIST_BUTTON_PREFIX}${safePage + 1}`)
        .setLabel('Next')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
    );
  }
  buttons.push(
    linkButton('Open on Steam', `https://store.steampowered.com/wishlist/profiles/${steamId}/`),
  );
  container
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(
      textBlock([
        `-# Page ${safePage + 1} of ${totalPages} · 🎯 ${RADAR_MARKER} pings you in the Steam channel when one goes on sale`,
      ]),
    )
    .addActionRowComponents(linkRow(buttons));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
