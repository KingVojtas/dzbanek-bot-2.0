import type { Client, Message, SendableChannels, TextBasedChannel } from 'discord.js';
import type { Config } from '../../config';
import {
  STEAM_DIGEST_SIZE,
  buildSteamDealsDisplay,
  collectMessageTextContent,
  extractHeadingTitles,
  looksLikeSteamDigest,
} from '../../core/display';
import type { Logger } from '../../core/logger';
import type { SteamDealItem } from '../../core/types';
import type { GuildSettingsStore } from '../guild-settings';
import type { SeenStore } from '../seen-store';
import { resolveDealTargets, type DealTarget } from '../targets';
import { SteamFeedReader } from './SteamFeedReader';
import { extractAppId, fetchSteamPrice, formatSteamPrice, parseDiscountPercent } from './SteamPriceApi';
import { fetchSteamReview, formatReview, isGoodReview, type SteamReviewInfo } from './SteamReviewApi';

function steamScope(guildId: string): string {
  return `steam:${guildId}`;
}

/** Daily Steam deals digest. Posts per guild; silence when that server has no new deals. */
export class SteamDealsService {
  private readonly reader = new SteamFeedReader();
  private pollInFlight: Promise<void> | null = null;

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly guildSettings: GuildSettingsStore,
  ) {}

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

    let items: SteamDealItem[];
    try {
      items = await this.reader.read();
    } catch (error) {
      this.logger.error('Steam: failed to fetch RSS feed:', error);
      return;
    }

    const withIds = items.filter((item) => Boolean(item.id));
    if (withIds.length === 0) {
      this.logger.info('Steam: feed empty — sending nothing.');
      return;
    }

    const freshByGuild = new Map<string, SteamDealItem[]>();
    const neededIds = new Set<string>();

    for (const target of targets) {
      const scope = steamScope(target.guildId);
      if ((await this.store.isEmpty(scope)) && !this.config.steam.postOnFirstRun) {
        await this.store.add(
          scope,
          withIds.map((item) => item.id),
        );
        this.logger.info(
          `Steam: seeded ${withIds.length} existing deal(s) silently for ${target.guildName}.`,
        );
        continue;
      }

      const fresh: SteamDealItem[] = [];
      for (const item of withIds) {
        if (!(await this.store.has(scope, item.id))) fresh.push(item);
      }
      if (fresh.length === 0) {
        this.logger.info(`Steam: no new deals for ${target.guildName} — sending nothing.`);
        continue;
      }
      freshByGuild.set(target.guildId, fresh);
      for (const item of fresh) neededIds.add(item.id);
    }

    if (freshByGuild.size === 0) return;

    const toReview = withIds.filter((item) => neededIds.has(item.id));
    const reviewEntries = await Promise.all(
      toReview.map(async (item) => {
        const appId = extractAppId(item.link);
        const review = appId ? await fetchSteamReview(appId) : null;
        return [item.id, review] as const;
      }),
    );
    const reviewMap = new Map<string, SteamReviewInfo | null>(reviewEntries);

    const priceCache = new Map<string, string | null>();
    let posted = 0;

    for (const target of targets) {
      const fresh = freshByGuild.get(target.guildId);
      if (!fresh) continue;

      const sent = await this.postToGuild(target, fresh, reviewMap, priceCache);
      if (sent) posted += 1;
    }

    this.logger.info(`Steam: posted digest to ${posted}/${targets.length} guild(s).`);
  }

  private async postToGuild(
    target: DealTarget,
    fresh: SteamDealItem[],
    reviewMap: Map<string, SteamReviewInfo | null>,
    priceCache: Map<string, string | null>,
  ): Promise<boolean> {
    const scope = steamScope(target.guildId);
    const passing = fresh.filter((item) => {
      const review = reviewMap.get(item.id);
      return Boolean(review && isGoodReview(review));
    });
    const rejected = fresh.filter((item) => {
      const review = reviewMap.get(item.id);
      return Boolean(review && !isGoodReview(review));
    });

    if (rejected.length > 0) {
      await this.store.add(
        scope,
        rejected.map((item) => item.id),
      );
    }

    if (passing.length === 0) {
      this.logger.info(
        `Steam: ${fresh.length} new deal(s) in ${target.guildName} but none passed reviews — sending nothing.`,
      );
      return false;
    }

    const byDiscount = (a: SteamDealItem, b: SteamDealItem) => {
      const da = parseDiscountPercent(a.discount) ?? 0;
      const db = parseDiscountPercent(b.discount) ?? 0;
      if (db !== da) return db - da;
      return a.gameName.localeCompare(b.gameName);
    };

    const top = [...passing].sort(byDiscount).slice(0, STEAM_DIGEST_SIZE);

    const lastDigest = await this.findLastSteamDigest(target.channel);
    if (lastDigest && this.isDuplicateDigest(lastDigest, top)) {
      await this.store.add(
        scope,
        passing.map((item) => item.id),
      );
      this.logger.info(`Steam: ${target.guildName} already lists these games — sending nothing.`);
      return false;
    }

    const prices = new Map<string, string | null>();
    const reviews = new Map<string, string>();
    await Promise.all(
      top.map(async (item) => {
        if (priceCache.has(item.id)) {
          prices.set(item.id, priceCache.get(item.id) ?? null);
          return;
        }
        const appId = extractAppId(item.link);
        if (!appId) {
          priceCache.set(item.id, null);
          prices.set(item.id, null);
          return;
        }
        const info = await fetchSteamPrice(appId);
        const formatted = info ? formatSteamPrice(info) : null;
        priceCache.set(item.id, formatted);
        prices.set(item.id, formatted);
      }),
    );
    for (const item of top) {
      const review = reviewMap.get(item.id);
      if (review) reviews.set(item.id, formatReview(review));
    }

    if (lastDigest) {
      try {
        await lastDigest.delete();
      } catch {
        /* ignore */
      }
    }

    try {
      const display = buildSteamDealsDisplay(top, prices, reviews);
      const sent = await target.channel.send({
        components: display.components,
        flags: display.flags,
      });
      await this.store.add(
        scope,
        passing.map((item) => item.id),
      );
      this.logger.info(`Steam: posted ${top.length} deal(s) to ${target.guildName}.`);
      await reactQuietly(sent, ['🔥', '💰', '👍']);
      return true;
    } catch (error) {
      this.logger.error(`Steam: failed to post to ${target.guildName}:`, error);
      return false;
    }
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
                /steam daily deals/i.test(e.title ?? '') || /steam deals/i.test(e.footer?.text ?? ''),
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
    let lastTitles = extractHeadingTitles(blob);
    if (lastTitles.length === 0 && lastMessage.embeds[0]) {
      lastTitles = lastMessage.embeds[0].fields.map((f) => f.name.replace(/^\d+\.\s*/, '').trim());
    }
    const newTitles = top.map((item) => item.gameName);
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
