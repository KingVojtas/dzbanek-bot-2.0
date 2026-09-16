import type { Client, Message, SendableChannels, TextBasedChannel } from 'discord.js';
import type { Config } from '../../config';
import { buildSteamDealsDigestEmbed } from '../../core/embeds';
import type { Logger } from '../../core/logger';
import type { SteamDealItem } from '../../core/types';
import type { SeenStore } from '../seen-store';
import { STEAM_SEEN_SCOPE, SteamFeedReader } from './SteamFeedReader';
import { extractAppId, fetchSteamPrice, formatSteamPrice, parseDiscountPercent } from './SteamPriceApi';
import { fetchSteamReview, formatReview, isGoodReview } from './SteamReviewApi';

const DIGEST_MAX = 10;

/** Daily Steam deals digest. Posts nothing when there are no new, well-reviewed deals. */
export class SteamDealsService {
  private readonly reader = new SteamFeedReader();
  private pollInFlight: Promise<void> | null = null;

  constructor(
    private readonly client: Client,
    private readonly store: SeenStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.runPoll().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async runPoll(): Promise<void> {
    const channelId = this.config.steam.channelId;
    if (!channelId) {
      this.logger.info('Steam: no channelId configured — skipping.');
      return;
    }

    const channel = await this.resolveChannel(channelId);
    if (!channel) {
      this.logger.warn(`Steam: channel ${channelId} missing or not sendable.`);
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

    if ((await this.store.isEmpty(STEAM_SEEN_SCOPE)) && !this.config.steam.postOnFirstRun) {
      await this.store.add(
        STEAM_SEEN_SCOPE,
        withIds.map((item) => item.id),
      );
      this.logger.info(`Steam: seeded ${withIds.length} existing deal(s) silently.`);
      return;
    }

    const fresh: SteamDealItem[] = [];
    for (const item of withIds) {
      if (!(await this.store.has(STEAM_SEEN_SCOPE, item.id))) fresh.push(item);
    }

    if (fresh.length === 0) {
      this.logger.info('Steam: no new deals — sending nothing.');
      return;
    }

    const reviewEntries = await Promise.all(
      fresh.map(async (item) => {
        const appId = extractAppId(item.link);
        const review = appId ? await fetchSteamReview(appId) : null;
        return [item.id, review] as const;
      }),
    );
    const reviewMap = new Map(reviewEntries);

    const passing = fresh.filter((item) => {
      const review = reviewMap.get(item.id);
      return Boolean(review && isGoodReview(review));
    });
    const rejected = fresh.filter((item) => !passing.some((p) => p.id === item.id));

    // Never retry mixed-review / unscored games. Passing IDs are stored after a successful post
    // so a send failure can retry next poll.
    if (rejected.length > 0) {
      await this.store.add(
        STEAM_SEEN_SCOPE,
        rejected.map((item) => item.id),
      );
    }

    if (passing.length === 0) {
      this.logger.info(
        `Steam: ${fresh.length} new deal(s) but none passed the review filter — sending nothing.`,
      );
      return;
    }

    const byDiscount = (a: SteamDealItem, b: SteamDealItem) => {
      const da = parseDiscountPercent(a.discount) ?? 0;
      const db = parseDiscountPercent(b.discount) ?? 0;
      if (db !== da) return db - da;
      return a.gameName.localeCompare(b.gameName);
    };

    const top = [...passing].sort(byDiscount).slice(0, DIGEST_MAX);

    const lastDigest = await this.findLastSteamDigest(channel);
    if (lastDigest && this.isDuplicateDigest(lastDigest, top)) {
      await this.store.add(
        STEAM_SEEN_SCOPE,
        passing.map((item) => item.id),
      );
      this.logger.info('Steam: last digest already lists these games — sending nothing.');
      return;
    }

    const prices = new Map<string, string | null>();
    const reviews = new Map<string, string>();
    await Promise.all(
      top.map(async (item) => {
        const appId = extractAppId(item.link);
        if (!appId) {
          prices.set(item.id, null);
          return;
        }
        const info = await fetchSteamPrice(appId);
        prices.set(item.id, info ? formatSteamPrice(info) : null);
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
      await channel.send({
        embeds: [buildSteamDealsDigestEmbed(top, prices, reviews)],
      });
      await this.store.add(
        STEAM_SEEN_SCOPE,
        passing.map((item) => item.id),
      );
      this.logger.info(`Steam: posted digest with ${top.length} new deal(s).`);
    } catch (error) {
      this.logger.error('Steam: failed to post digest:', error);
    }
  }

  private async resolveChannel(channelId: string): Promise<SendableChannels | null> {
    const fetched = await this.client.channels.fetch(channelId).catch(() => null);
    if (!fetched || !fetched.isSendable()) return null;
    return fetched;
  }

  private async findLastSteamDigest(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await (channel as TextBasedChannel).messages.fetch({ limit: 30 });
      const mine = [...recent.values()]
        .filter((msg) => msg.author.id === this.client.user?.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

      return (
        mine.find((msg) =>
          msg.embeds.some(
            (e) => /steam daily deals/i.test(e.title ?? '') || /steam deals/i.test(e.footer?.text ?? ''),
          ),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private isDuplicateDigest(lastMessage: Message, top: SteamDealItem[]): boolean {
    if (top.length === 0 || lastMessage.embeds.length === 0) return false;
    const lastTitles = lastMessage.embeds[0].fields.map((f) => f.name.replace(/^\d+\.\s*/, '').trim());
    const newTitles = top.map((item) => item.gameName);
    return (
      lastTitles.length === newTitles.length && lastTitles.every((title, i) => title === newTitles[i])
    );
  }
}
