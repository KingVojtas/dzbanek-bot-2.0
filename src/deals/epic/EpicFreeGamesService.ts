import type { Client, Message, SendableChannels, TextBasedChannel } from 'discord.js';
import type { Config } from '../../config';
import {
  buildEpicFreeGamesDisplay,
  collectMessageTextContent,
  extractHeadingTitles,
  looksLikeEpicDigest,
} from '../../core/display';
import type { Logger } from '../../core/logger';
import type { EpicFreeGame } from '../../core/types';
import type { KitchenBoard } from '../../kitchen/KitchenBoard';
import type { GuildSettingsStore } from '../guild-settings';
import type { SeenStore } from '../seen-store';
import { resolveDealTargets, type DealTarget } from '../targets';

const EPIC_API_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions' +
  '?locale=en-US&country=US&allowCountries=US';

function epicScope(guildId: string): string {
  return `epic:${guildId}`;
}

interface RawKeyImage {
  type: string;
  url: string;
}

interface RawPromoOffer {
  startDate: string;
  endDate: string;
  discountSetting: { discountType: string; discountPercentage: number };
}

interface RawPromoGroup {
  promotionalOffers: RawPromoOffer[];
}

interface RawMapping {
  pageSlug: string;
  pageType: string;
}

interface RawElement {
  title: string;
  description: string;
  keyImages: RawKeyImage[];
  seller: { name: string };
  productSlug: string | null;
  catalogNs: { mappings: RawMapping[] | null };
  offerMappings: RawMapping[] | null;
  price: {
    totalPrice: {
      discountPrice: number;
      originalPrice: number;
      fmtPrice: { originalPrice: string };
    };
  };
  promotions: {
    promotionalOffers: RawPromoGroup[];
    upcomingPromotionalOffers: RawPromoGroup[];
  } | null;
}

interface RawApiResponse {
  data: { Catalog: { searchStore: { elements: RawElement[] } } };
}

function lineupFingerprint(games: EpicFreeGame[]): string {
  return games
    .map((g) => `${g.isUpcoming ? 'U' : 'C'}:${g.title.trim().toLowerCase()}`)
    .sort()
    .join('|');
}

/** Polls Epic's free-games API. Posts nothing when the weekly lineup is unchanged. */
export class EpicFreeGamesService {
  private pollInFlight: Promise<void> | null = null;
  private kitchen: KitchenBoard | null = null;

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
      'epic',
    );
    if (targets.length === 0) {
      this.logger.info('Epic: no guild channels configured — skipping.');
      return;
    }

    let games: EpicFreeGame[];
    try {
      games = await this.fetchFreeGames();
    } catch (error) {
      this.logger.error('Epic: failed to fetch free games:', error);
      return;
    }

    if (games.length === 0) {
      this.logger.info('Epic: no free or upcoming games — sending nothing.');
      return;
    }

    const fingerprint = lineupFingerprint(games);
    let posted = 0;
    for (const target of targets) {
      this.kitchen?.recordEpic(target.guildId, games);
      const sent = await this.postToGuild(target, games, fingerprint);
      if (sent) posted += 1;
      this.kitchen?.refresh(target.guildId);
    }
    this.logger.info(`Epic: posted lineup to ${posted}/${targets.length} guild(s).`);
  }

  private async postToGuild(
    target: DealTarget,
    games: EpicFreeGame[],
    fingerprint: string,
  ): Promise<boolean> {
    const scope = epicScope(target.guildId);

    if ((await this.store.isEmpty(scope)) && !this.config.epic.postOnFirstRun) {
      await this.store.add(scope, [fingerprint]);
      this.logger.info(`Epic: seeded current lineup silently for ${target.guildName}.`);
      return false;
    }

    if (await this.store.has(scope, fingerprint)) {
      this.logger.info(`Epic: lineup already posted in ${target.guildName} — sending nothing.`);
      return false;
    }

    const previous = await this.findLastEpicDigest(target.channel);
    if (previous && this.titlesMatch(previous, games)) {
      await this.store.add(scope, [fingerprint]);
      this.logger.info(`Epic: ${target.guildName} already lists this lineup — sending nothing.`);
      return false;
    }

    if (previous) {
      try {
        await previous.delete();
      } catch {
        /* ignore */
      }
    }

    try {
      const display = buildEpicFreeGamesDisplay(games);
      const sent = await target.channel.send({
        components: display.components,
        flags: display.flags,
      });
      await this.store.add(scope, [fingerprint]);
      this.logger.info(`Epic: posted free games to ${target.guildName}.`);
      await reactQuietly(sent, ['🎁', '🆓', '⭐']);
      return true;
    } catch (error) {
      this.logger.error(`Epic: failed to post to ${target.guildName}:`, error);
      return false;
    }
  }

  private async fetchFreeGames(): Promise<EpicFreeGame[]> {
    const response = await fetch(EPIC_API_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Epic API returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as RawApiResponse;
    const elements = json.data?.Catalog?.searchStore?.elements ?? [];

    const current: EpicFreeGame[] = [];
    const upcoming: EpicFreeGame[] = [];

    for (const el of elements) {
      if (isCurrentlyFree(el)) current.push(toEpicFreeGame(el, false));
      else if (isUpcomingFree(el)) upcoming.push(toEpicFreeGame(el, true));
    }

    return [...current, ...upcoming];
  }

  private async findLastEpicDigest(channel: SendableChannels): Promise<Message | null> {
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
            looksLikeEpicDigest(blob) ||
            msg.embeds.some(
              (e) => /epic games/i.test(e.title ?? '') || /epic games store/i.test(e.footer?.text ?? ''),
            )
          );
        }) ?? null
      );
    } catch {
      return null;
    }
  }

  private titlesMatch(lastMessage: Message, games: EpicFreeGame[]): boolean {
    const blob = collectMessageTextContent(lastMessage);
    let lastTitles = extractHeadingTitles(blob);
    if (lastTitles.length === 0 && lastMessage.embeds[0]) {
      lastTitles = lastMessage.embeds[0].fields
        .map((f) => f.name.trim())
        .filter((name) => name !== '\u200b');
    }
    const newTitles = games.map((g) => g.title);
    return (
      lastTitles.length === newTitles.length && lastTitles.every((title, i) => title === newTitles[i])
    );
  }
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

function isCurrentlyFree(el: RawElement): boolean {
  const { discountPrice, originalPrice } = el.price.totalPrice;
  if (discountPrice !== 0 || originalPrice === 0) return false;
  return (el.promotions?.promotionalOffers ?? []).some((g) =>
    g.promotionalOffers.some((o) => o.discountSetting.discountPercentage === 0),
  );
}

function isUpcomingFree(el: RawElement): boolean {
  return (el.promotions?.upcomingPromotionalOffers ?? []).some((g) =>
    g.promotionalOffers.some((o) => o.discountSetting.discountPercentage === 0),
  );
}

function getActiveEndDate(el: RawElement): string | undefined {
  return el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0]?.endDate;
}

function getUpcomingStartDate(el: RawElement): string | undefined {
  return el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0]?.startDate;
}

function getUpcomingEndDate(el: RawElement): string | undefined {
  return el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0]?.endDate;
}

const TALL_IMAGE_TYPES = [
  'Thumbnail',
  'OfferImageTall',
  'DieselStoreFrontTall',
  'DieselGameBoxTall',
];
const WIDE_IMAGE_TYPES = [
  'OfferImageWide',
  'DieselStoreFrontWide',
  'DieselGameBox',
  'featuredMedia',
  'OgImage',
];

function isHttpImage(url: string): boolean {
  return (
    /^https:\/\//i.test(url) &&
    !/video\.qs:\/\//i.test(url) &&
    !/\.(mp4|webm|m3u8)(\?|$)/i.test(url)
  );
}

function pickKeyImage(el: RawElement, types: string[]): string | undefined {
  for (const type of types) {
    const found = el.keyImages.find((img) => img.type === type && isHttpImage(img.url));
    if (found) return found.url;
  }
  return el.keyImages.find((img) => isHttpImage(img.url))?.url;
}

function buildStoreUrl(el: RawElement): string {
  const slug =
    el.catalogNs.mappings?.find((m) => m.pageType === 'productHome')?.pageSlug ??
    el.offerMappings?.find((m) => m.pageType === 'productHome')?.pageSlug ??
    el.productSlug ??
    null;
  return slug
    ? `https://store.epicgames.com/en-US/p/${slug}`
    : 'https://store.epicgames.com/en-US/free-games';
}

function toEpicFreeGame(el: RawElement, isUpcoming: boolean): EpicFreeGame {
  const tall = pickKeyImage(el, TALL_IMAGE_TYPES);
  const wide = pickKeyImage(el, WIDE_IMAGE_TYPES);
  return {
    title: el.title,
    description: el.description,
    originalPrice: el.price.totalPrice.fmtPrice.originalPrice,
    storeUrl: buildStoreUrl(el),
    image: tall ?? wide,
    heroImage: wide ?? tall,
    seller: el.seller?.name || undefined,
    endDate: isUpcoming ? getUpcomingEndDate(el) : getActiveEndDate(el),
    isUpcoming,
    upcomingStartDate: isUpcoming ? getUpcomingStartDate(el) : undefined,
  };
}
