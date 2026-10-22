import type { Guild, SendableChannels } from 'discord.js';
import {
  buildWishlistRadarDisplay,
  type WishlistGame,
  type WishlistRadarView,
} from '../../core/display';
import type { Logger } from '../../core/logger';
import type { SteamDealItem } from '../../core/types';
import type { SeenStore } from '../seen-store';
import { attachSteamArtwork } from './SteamArtwork';
import {
  extractAppId,
  fetchSteamPrices,
  formatSteamPrice,
  type SteamPriceInfo,
} from './SteamPriceApi';
import { attachSteamSaleEnds } from './SteamSpecialsReader';
import { fetchAppNames, fetchWishlist } from './SteamWishlist';
import type { SteamLinkStore } from './steam-links';

/** A wishlisted game that is on sale right now. */
export interface WishlistHit extends WishlistGame {
  appId: string;
  percent: number;
}

/** Linked member → their hits, deepest discount first. */
export type WishlistScan = Map<string, WishlistHit[]>;

/** Most people one card names; more would crowd past Discord's component cap. */
const RADAR_PEOPLE_MAX = 20;

function radarScope(guildId: string, userId: string): string {
  return `wish:${guildId}:${userId}`;
}

/** Same game, same discount: announced once. A deeper cut counts as new. */
function hitKey(hit: WishlistHit): string {
  return `${hit.appId}:${hit.percent}`;
}

/**
 * Watches linked members' Steam wishlists. One scan a day reads every
 * wishlist, prices the union once, and keeps only what is on sale.
 */
export class WishlistRadar {
  constructor(
    private readonly links: SteamLinkStore,
    private readonly seen: SeenStore,
    private readonly logger: Logger,
  ) {}

  /** Every linked member's hits. Members with private or unreachable wishlists are skipped. */
  async scan(): Promise<WishlistScan> {
    const rows = await this.links.all();
    const wishlists = new Map<string, string[]>();
    for (const row of rows) {
      const ids = await fetchWishlist(row.steamId);
      if (ids && ids.length > 0) wishlists.set(row.userId, ids);
    }
    const hits = await this.hitsFor(wishlists);
    const total = [...hits.values()].reduce((sum, list) => sum + list.length, 0);
    this.logger.info(
      `Wishlist radar: ${rows.length} linked, ${wishlists.size} readable, ${total} game(s) on sale.`,
    );
    return hits;
  }

  /** One member's hits right now, for `/steam wishlist`. Null when Steam did not answer. */
  async scanOne(userId: string, steamId: string): Promise<WishlistHit[] | null> {
    const ids = await fetchWishlist(steamId);
    if (!ids) return null;
    const hits = await this.hitsFor(new Map([[userId, ids]]));
    return hits.get(userId) ?? [];
  }

  private async hitsFor(wishlists: Map<string, string[]>): Promise<WishlistScan> {
    const union = [...new Set([...wishlists.values()].flat())];
    const prices = await fetchSteamPrices(union);
    const onSale = union.filter((id) => (prices.get(id)?.discountPercent ?? 0) > 0);
    const names = await fetchAppNames(onSale);

    const items = new Map<string, SteamDealItem>();
    for (const appId of onSale) {
      const name = names.get(appId);
      const url = name?.url ?? `https://store.steampowered.com/app/${appId}/`;
      items.set(appId, {
        id: `wish_${appId}`,
        title: name?.name ?? `App ${appId}`,
        gameName: name?.name ?? `App ${appId}`,
        link: url,
        discount: `-${prices.get(appId)!.discountPercent}%`,
      });
    }
    await Promise.all([
      attachSteamArtwork([...items.values()]),
      attachSteamSaleEnds([...items.values()]),
    ]);

    const scan: WishlistScan = new Map();
    for (const [userId, ids] of wishlists) {
      const hits = ids
        .filter((id) => items.has(id))
        .map((id) => toHit(id, items.get(id)!, prices.get(id)!))
        .sort((a, b) => b.percent - a.percent);
      scan.set(userId, hits);
    }
    return scan;
  }

  /** The scan narrowed to this server's members. */
  async forGuild(guild: Guild, scan: WishlistScan): Promise<WishlistScan> {
    const ids = [...scan.keys()];
    if (ids.length === 0) return new Map();
    const members = await guild.members.fetch({ user: ids }).catch(() => null);
    if (!members) return new Map();
    return new Map([...scan].filter(([userId]) => members.has(userId)));
  }

  /**
   * Post this server's new hits. Only people with something new are pinged,
   * and each hit is announced once per discount.
   */
  async post(
    guildId: string,
    guildName: string,
    channel: SendableChannels,
    scan: WishlistScan,
  ): Promise<void> {
    const fresh: WishlistScan = new Map();
    for (const [userId, hits] of scan) {
      const unseen: WishlistHit[] = [];
      for (const hit of hits) {
        if (!(await this.seen.has(radarScope(guildId, userId), hitKey(hit)))) unseen.push(hit);
      }
      if (unseen.length > 0) fresh.set(userId, unseen);
    }
    if (fresh.size === 0) {
      this.logger.info(`Wishlist radar: nothing new in ${guildName}.`);
      return;
    }

    const view = radarView(scan, fresh);
    const display = buildWishlistRadarDisplay(view);
    await channel.send({
      components: display.components,
      flags: display.flags,
      allowedMentions: { users: [...fresh.keys()] },
    });
    for (const [userId, hits] of fresh) {
      await this.seen.add(radarScope(guildId, userId), hits.map(hitKey));
    }
    const count = [...fresh.values()].reduce((sum, list) => sum + list.length, 0);
    this.logger.info(
      `Wishlist radar: ${count} new hit(s) for ${fresh.size} member(s) in ${guildName}.`,
    );
  }
}

function toHit(appId: string, item: SteamDealItem, price: SteamPriceInfo): WishlistHit {
  return { appId, item, price: formatSteamPrice(price), percent: price.discountPercent };
}

/**
 * Per-person lines carry only new hits. "Wanted together" lists a game two or
 * more members want, when it is new for at least one of them.
 */
export function radarView(all: WishlistScan, fresh: WishlistScan): WishlistRadarView {
  const wanters = new Map<string, { hit: WishlistHit; userIds: string[] }>();
  for (const [userId, hits] of all) {
    for (const hit of hits) {
      const entry = wanters.get(hit.appId) ?? { hit, userIds: [] };
      entry.userIds.push(userId);
      wanters.set(hit.appId, entry);
    }
  }
  const freshIds = new Set([...fresh.values()].flat().map((hit) => hit.appId));
  const together = [...wanters.values()]
    .filter((entry) => entry.userIds.length >= 2 && freshIds.has(entry.hit.appId))
    .sort((a, b) => b.userIds.length - a.userIds.length || b.hit.percent - a.hit.percent)
    .map((entry) => ({ game: entry.hit, userIds: entry.userIds }));
  const people = [...fresh]
    .map(([userId, games]) => ({ userId, games }))
    .sort((a, b) => b.games.length - a.games.length)
    .slice(0, RADAR_PEOPLE_MAX);
  return { together, people };
}

/** Deal id → members who wishlisted that game, for the digest's 👀 line. */
export function digestWishers(top: SteamDealItem[], scan: WishlistScan): Map<string, string[]> {
  const byApp = new Map<string, string[]>();
  for (const [userId, hits] of scan) {
    for (const hit of hits) byApp.set(hit.appId, [...(byApp.get(hit.appId) ?? []), userId]);
  }
  const wishers = new Map<string, string[]>();
  for (const item of top) {
    const appId = extractAppId(item.link);
    const users = appId ? byApp.get(appId) : undefined;
    if (users?.length) wishers.set(item.id, users);
  }
  return wishers;
}
