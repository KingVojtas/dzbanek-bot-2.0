import type { Client, Message, SendableChannels, TextBasedChannel } from 'discord.js';
import type { Config } from '../../config';
import {
  STEAM_DIGEST_SIZE,
  STEAM_SHELF_MARKER,
  buildSteamDealsDisplay,
  collectMessageTextContent,
  extractSteamDigestTitles,
  looksLikeSteamDigest,
  steamDealTitle,
} from '../../core/display';
import type { Logger } from '../../core/logger';
import type { SteamDealItem } from '../../core/types';
import type { KitchenBoard } from '../../kitchen/KitchenBoard';
import type { GuildSettingsStore } from '../guild-settings';
import type { SeenStore } from '../seen-store';
import { resolveDealTargets, type DealTarget } from '../targets';
import { attachSteamArtwork } from './SteamArtwork';
import {
  attachSteamShelfMeta,
  attachStoreProfiles,
  type SteamStoreProfile,
} from './SteamBlockbuster';
import { SteamFeedReader } from './SteamFeedReader';
import { digestWishers, type WishlistRadar, type WishlistScan } from './WishlistRadar';
import { SteamSpecialsReader, attachSteamSaleEnds } from './SteamSpecialsReader';
import {
  extractAppId,
  fetchSteamPrice,
  formatSteamPrice,
  type SteamPriceInfo,
} from './SteamPriceApi';
import { fetchSteamReview, type SteamReviewInfo } from './SteamReviewApi';
import {
  compareSteamDeals,
  isSteamFloorPrice,
  selectSteamDigest,
  steamDigestFingerprint,
  uniqueSteamApps,
} from './select-digest';

/** Deepest discounts we ask Steam about before picking the 10-game card. */
const STEAM_REVIEW_WINDOW = 40;

/** Extra picks priced alongside the ten, to stand in for a sale that already ended. */
const STEAM_SPARE_PICKS = 6;

function steamDigestScope(guildId: string): string {
  return `steam-digest:${guildId}`;
}

/** Daily Steam deals digest. Always aims for STEAM_DIGEST_SIZE games per post. */
export class SteamDealsService {
  private readonly reader = new SteamFeedReader();
  private readonly specials = new SteamSpecialsReader();
  private pollInFlight: Promise<void> | null = null;
  private kitchen: KitchenBoard | null = null;
  private radar: WishlistRadar | null = null;

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly guildSettings: GuildSettingsStore,
  ) {}

  setKitchen(kitchen: KitchenBoard): void {
    this.kitchen = kitchen;
  }

  setRadar(radar: WishlistRadar): void {
    this.radar = radar;
  }

  async poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.runPoll().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async runPoll(): Promise<void> {
    const targets = await resolveDealTargets(
      this.client,
      this.guildSettings,
      this.config,
      this.logger,
      'steam',
    );
    if (targets.length === 0) {
      this.logger.info('Steam: no guild channels configured — skipping.');
      return;
    }

    let feedItems: SteamDealItem[] = [];
    try {
      feedItems = await this.reader.read();
    } catch (error) {
      this.logger.error('Steam: failed to fetch RSS feed:', error);
    }

    let specials: SteamDealItem[] = [];
    let reviewCounts = new Map<string, number>();
    try {
      const list = await this.specials.read();
      specials = list.items;
      reviewCounts = list.reviewCounts;
    } catch (error) {
      this.logger.error('Steam: failed to fetch specials search:', error);
    }

    const pool = uniqueSteamApps(
      [...feedItems, ...specials].filter((item) => Boolean(item.id) && Boolean(item.link)),
    );
    if (pool.length === 0) {
      this.logger.info('Steam: no deals from the feed or specials — sending nothing.');
      return;
    }

    const aboveFloor = pool.filter((item) => !isSteamFloorPrice(item));
    const shelf = aboveFloor.length >= STEAM_DIGEST_SIZE ? aboveFloor : pool;
    if (shelf !== pool) {
      this.logger.info(
        `Steam: left out ${pool.length - aboveFloor.length} game(s) at the 0,49€ minimum.`,
      );
    }

    const profiles = new Map<string, SteamStoreProfile | null>();
    await attachStoreProfiles(shelf, profiles);
    // The feeds lag behind Steam. A game whose store page shows no discount is off the shelf.
    const offSale = (item: SteamDealItem): boolean =>
      profiles.get(extractAppId(item.link) ?? '')?.discountPercent === 0;

    const ranked = shelf
      .filter((item) => !offSale(item))
      .sort((a, b) => {
        const tier = Number(Boolean(b.blockbuster)) - Number(Boolean(a.blockbuster));
        if (tier !== 0) return tier;
        return compareSteamDeals(
          a,
          b,
          (item) => reviewCounts.get(extractAppId(item.link) ?? '') ?? 0,
        );
      });
    const candidates = ranked.slice(0, STEAM_REVIEW_WINDOW);
    const seen = new Set(candidates.map((item) => item.id));
    for (const item of feedItems) {
      const appId = extractAppId(item.link);
      const kept = pool.find((entry) => extractAppId(entry.link) === appId) ?? item;
      if (!kept.id || seen.has(kept.id) || offSale(kept)) continue;
      if (shelf !== pool && isSteamFloorPrice(kept)) continue;
      candidates.push(kept);
      seen.add(kept.id);
    }
    this.logger.info(
      `Steam: ${pool.length} discounted game(s) (${feedItems.length} from the feed, ${specials.length} from specials); reviewing ${candidates.length}.`,
    );

    const reviewMap = await this.fetchReviews(candidates);
    const picks = selectSteamDigest(candidates, reviewMap, STEAM_DIGEST_SIZE + STEAM_SPARE_PICKS);
    const priceInfo = await this.fetchPrices(picks);
    const live = picks.filter((item) => priceInfo.get(item.id)?.discountPercent !== 0);
    if (live.length < picks.length) {
      this.logger.info(
        `Steam: ${picks.length - live.length} pick(s) are no longer on sale at Steam — left out.`,
      );
    }
    const top = live.slice(0, STEAM_DIGEST_SIZE);
    if (top.length === 0) {
      this.logger.info('Steam: nothing to put in the digest — sending nothing.');
      return;
    }

    if (top.length < STEAM_DIGEST_SIZE) {
      this.logger.warn(
        `Steam: digest only has ${top.length}/${STEAM_DIGEST_SIZE} games (pool has ${pool.length}).`,
      );
    }

    const fingerprint = steamDigestFingerprint(top);
    const blockbusters = top.filter((item) => item.blockbuster).length;
    this.logger.info(`Steam: ${blockbusters} blockbuster(s) in this ${top.length}-game digest.`);
    const prices = new Map(
      top.map((item) => {
        const info = priceInfo.get(item.id);
        return [item.id, info ? formatSteamPrice(info) : null] as const;
      }),
    );
    await Promise.all([
      attachSteamArtwork(top),
      attachSteamShelfMeta(top, profiles),
      attachSteamSaleEnds(top),
    ]);
    const missingArt = top.filter((item) => !item.image).length;
    if (missingArt > 0) {
      this.logger.warn(`Steam: no artwork for ${missingArt} of ${top.length} games.`);
    }

    const scan = await this.scanWishlists();

    let posted = 0;
    for (const target of targets) {
      this.kitchen?.recordSteam(target.guildId, top, prices, reviewMap, target.channel.id);
      const mine = await this.wishlistsIn(target.guildId, scan);
      const wishers = digestWishers(top, mine);
      const sent = await this.postToGuild(target, top, fingerprint, prices, reviewMap, wishers);
      if (sent) posted += 1;
      // Even when the digest was a repeat: the wishlists may still have news.
      await this.radar
        ?.post(target.guildId, target.guildName, target.channel, mine)
        .catch((error) =>
          this.logger.error(`Wishlist radar failed in ${target.guildName}:`, error),
        );
      this.kitchen?.refresh(target.guildId);
    }

    this.logger.info(`Steam: posted digest to ${posted}/${targets.length} guild(s).`);
  }

  private async postToGuild(
    target: DealTarget,
    top: SteamDealItem[],
    fingerprint: string,
    prices: Map<string, string | null>,
    reviewMap: Map<string, SteamReviewInfo | null>,
    wishers: Map<string, string[]>,
  ): Promise<boolean> {
    const scope = steamDigestScope(target.guildId);

    if ((await this.store.isEmpty(scope)) && !this.config.steam.postOnFirstRun) {
      await this.store.add(scope, [fingerprint]);
      this.logger.info(`Steam: seeded current digest silently for ${target.guildName}.`);
      return false;
    }

    if (await this.store.has(scope, fingerprint)) {
      this.logger.info(
        `Steam: same ${top.length}-game digest already posted in ${target.guildName}.`,
      );
      return false;
    }

    const lastDigest = await this.findLastSteamDigest(target.channel);
    if (lastDigest && this.isDuplicateDigest(lastDigest, top)) {
      await this.store.add(scope, [fingerprint]);
      this.logger.info(`Steam: ${target.guildName} already lists these games — sending nothing.`);
      return false;
    }

    try {
      const display = buildSteamDealsDisplay(top, prices, reviewMap, wishers);
      // The 👀 line names people; the radar card is the one that pings.
      const sent = await target.channel.send({
        components: display.components,
        flags: display.flags,
        allowedMentions: { parse: [] },
      });
      if (lastDigest) {
        try {
          await lastDigest.delete();
        } catch {
          /* ignore */
        }
      }
      await this.store.add(scope, [fingerprint]);
      this.logger.info(`Steam: posted ${top.length} deal(s) to ${target.guildName}.`);
      await reactQuietly(sent, ['🔥', '💰', '👍']);
      return true;
    } catch (error) {
      this.logger.error(`Steam: failed to post to ${target.guildName}:`, error);
      return false;
    }
  }

  private async fetchReviews(items: SteamDealItem[]): Promise<Map<string, SteamReviewInfo | null>> {
    const entries = await mapPool(items, 6, async (item) => {
      const appId = extractAppId(item.link);
      const review = appId ? await fetchSteamReview(appId) : null;
      return [item.id, review] as const;
    });
    return new Map(entries);
  }

  private async scanWishlists(): Promise<WishlistScan> {
    if (!this.radar) return new Map();
    try {
      return await this.radar.scan();
    } catch (error) {
      this.logger.error('Wishlist radar scan failed:', error);
      return new Map();
    }
  }

  private async wishlistsIn(guildId: string, scan: WishlistScan): Promise<WishlistScan> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild || !this.radar || scan.size === 0) return new Map();
    return this.radar.forGuild(guild, scan);
  }

  /** Steam DE's live price for each game; null when Steam did not answer. */
  private async fetchPrices(items: SteamDealItem[]): Promise<Map<string, SteamPriceInfo | null>> {
    const entries = await mapPool(items, 6, async (item) => {
      const appId = extractAppId(item.link);
      if (!appId) return [item.id, null] as const;
      return [item.id, await fetchSteamPrice(appId)] as const;
    });
    return new Map(entries);
  }

  private async findLastSteamDigest(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await (channel as TextBasedChannel).messages.fetch({ limit: 30 });
      const mine = [...recent.values()]
        .filter((msg) => msg.author.id === this.client.user?.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

      return (
        mine.find((msg) => {
          const blob = collectMessageTextContent(msg);
          return (
            looksLikeSteamDigest(blob) ||
            msg.embeds.some(
              (e) =>
                /steam daily deals/i.test(e.title ?? '') ||
                /steam deals/i.test(e.footer?.text ?? ''),
            )
          );
        }) ?? null
      );
    } catch {
      return null;
    }
  }

  private isDuplicateDigest(lastMessage: Message, top: SteamDealItem[]): boolean {
    if (top.length === 0) return false;
    const blob = collectMessageTextContent(lastMessage);
    if (!blob.includes(STEAM_SHELF_MARKER)) return false;
    const lastTitles = extractSteamDigestTitles(blob);
    const newTitles = top.map(steamDealTitle);
    return (
      lastTitles.length === newTitles.length &&
      lastTitles.every((title, i) => title === newTitles[i])
    );
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function reactQuietly(message: Message, emojis: string[]): Promise<void> {
  for (const emoji of emojis) {
    try {
      await message.react(emoji);
    } catch {
      /* missing Add Reactions permission */
    }
  }
}
