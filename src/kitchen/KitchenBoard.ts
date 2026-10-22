import {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type SendableChannels,
  type VoiceBasedChannel,
} from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { EpicFreeGame, SteamDealItem } from '../core/types';
import {
  collectMessageTextContent,
  discordTime,
  epicWorth,
  linkText,
  steamMoneyLine,
  steamPriceBits,
  steamReviewChip,
  steamSaleEnds,
} from '../core/display';
import { upcomingQueue } from '../core/embeds';
import { isUnknownMessage } from '../core/discord-errors';
import type { SteamReviewInfo } from '../deals/steam/SteamReviewApi';
import type { SeenStore } from '../deals/seen-store';
import { resolveGuildSendableChannel } from '../deals/targets';
import type { GuildSettingsStore } from '../deals/guild-settings';
import type { MusicManager } from '../music/MusicManager';
import type { RadioManager } from '../radio/RadioManager';
import { getStation, type RadioStation, type StationId } from '../radio/station';
import {
  buildKitchenChartDisplay,
  markRadioNightRan,
  radioNightPlayedStation,
  rankCatches,
} from './chart';
import {
  KITCHEN_COLOR,
  buildKitchenBoardDisplay,
  kitchenViewKey,
  looksLikeKitchenBoard,
  type KitchenBoardView,
  type KitchenDealTeaser,
} from './display';
import { RadioCatchStore } from './catches';
import {
  RADIO_VOTE_END_HOUR,
  chartWeek,
  isRadioVoteOpen,
  radioNightWeekKey,
  zonedDateTimeToUtc,
} from './time';
import { RadioNightVoteStore, isStationId, type VoteCounts } from './votes';

const TICK_MS = 20_000;
const DEBOUNCE_MS = 1_200;

interface SteamSnapshot {
  items: SteamDealItem[];
  prices: Map<string, string | null>;
  reviews: Map<string, SteamReviewInfo | null>;
  /** Where the full digest was posted. */
  channelId?: string;
}

interface EpicSnapshot {
  games: EpicFreeGame[];
  channelId?: string;
}

function calendarDate(timeZone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone });
}

function displayName(member: GuildMember): string {
  return (member.displayName || member.user.globalName || member.user.username).slice(0, 32);
}

/** One living Kitchen Board message per guild, edited in place. */
export class KitchenBoard {
  private readonly steamByGuild = new Map<string, SteamSnapshot>();
  private readonly epicByGuild = new Map<string, EpicSnapshot>();
  private readonly lastKey = new Map<string, string>();
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly votes = new RadioNightVoteStore();
  private readonly catches = new RadioCatchStore();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: Client,
    private readonly music: MusicManager,
    private readonly radio: RadioManager,
    private readonly guildSettings: GuildSettingsStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async castVote(
    guildId: string,
    userId: string,
    stationId: StationId,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const settings = await this.guildSettings.get(guildId);
    if (!settings.radioNightEnabled || !settings.radioNightChannelId) {
      return { ok: false, reason: 'Radio Night is not scheduled. Use `/radio night` first.' };
    }
    if (!isRadioVoteOpen(this.config.timezone)) {
      return { ok: false, reason: 'Voting is Friday 12:00–20:00 Prague.' };
    }
    await this.votes.cast(guildId, radioNightWeekKey(this.config.timezone), userId, stationId);
    this.lastKey.delete(guildId);
    this.refresh(guildId);
    return { ok: true };
  }

  attach(): void {
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const guildId = newState.guild.id;
      // The board lists who is in the bot's channel. A mute or a move anywhere
      // else changes nothing on it.
      const botChannelId =
        this.radio.channelId(guildId) ??
        this.music.get(guildId)?.connection.joinConfig.channelId ??
        null;
      const isBot = newState.id === this.client.user?.id;
      const touchesBot =
        botChannelId !== null &&
        (oldState.channelId === botChannelId || newState.channelId === botChannelId);
      if (!isBot && !touchesBot) return;
      this.refresh(guildId);
    });

    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.refreshAll().catch((error) =>
        this.logger.debug('Kitchen board tick failed:', error),
      );
    }, TICK_MS);
    this.tickTimer.unref?.();
  }

  recordSteam(
    guildId: string,
    items: SteamDealItem[],
    prices: Map<string, string | null>,
    reviews: Map<string, SteamReviewInfo | null>,
    channelId?: string,
  ): void {
    this.steamByGuild.set(guildId, { items, prices, reviews, channelId });
  }

  recordEpic(guildId: string, games: EpicFreeGame[], channelId?: string): void {
    this.epicByGuild.set(guildId, { games, channelId });
  }

  refresh(guildId: string): void {
    const existing = this.debounce.get(guildId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounce.delete(guildId);
      void this.push(guildId).catch((error) =>
        this.logger.debug(`Kitchen board update failed for ${guildId}:`, error),
      );
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.debounce.set(guildId, timer);
  }

  async refreshAll(): Promise<void> {
    const rows = await this.guildSettings.all();
    for (const row of rows) {
      if (!row.kitchenEnabled || !row.kitchenChannelId) continue;
      this.refresh(row.guildId);
    }
  }

  async noteJoin(guildId: string): Promise<void> {
    const settings = await this.guildSettings.get(guildId);
    if (!settings.kitchenEnabled || !settings.kitchenChannelId) return;
    const today = calendarDate(this.config.timezone);
    const count = settings.kitchenJoinDate === today ? settings.kitchenJoinCount + 1 : 1;
    await this.guildSettings.upsert(guildId, {
      kitchenJoinDate: today,
      kitchenJoinCount: count,
    });
    this.refresh(guildId);
  }

  async ensurePosted(guildId: string): Promise<void> {
    this.lastKey.delete(guildId);
    await this.push(guildId);
  }

  async runRadioNights(): Promise<void> {
    const rows = await this.guildSettings.all();
    const weekKey = radioNightWeekKey(this.config.timezone);
    for (const row of rows) {
      if (!row.radioNightEnabled || !row.radioNightChannelId) continue;
      const tieBreak =
        pickStationId(row.radioNightStation) ?? pickStationId(row.lastRadioStation) ?? 'beat';
      const winnerId = await this.votes.winner(row.guildId, weekKey, tieBreak);
      const station = getStation(winnerId);
      if (!station) {
        this.logger.warn(`Radio Night: unknown station "${winnerId}" in ${row.guildId}.`);
        continue;
      }
      const counts = await this.votes.counts(row.guildId, weekKey);
      const total = counts.kiss + counts.rock + counts.beat;
      await this.guildSettings.upsert(row.guildId, {
        radioNightStation: station.id,
        lastRadioStation: station.id,
      });
      try {
        const started = await this.startRadioNight(
          row.guildId,
          row.radioNightChannelId,
          station,
          total > 0 ? counts : null,
        );
        if (started) await markRadioNightRan(row.guildId, weekKey, station.id);
      } catch (error) {
        this.logger.error(`Radio Night failed in ${row.guildId}:`, error);
      }
    }
  }

  /** Sunday postcard: this week’s catches and Friday’s Radio Night. */
  async runWeeklyCharts(seen: SeenStore): Promise<void> {
    const week = chartWeek(this.config.timezone);
    const rows = await this.guildSettings.all();
    for (const row of rows) {
      if (!row.kitchenEnabled || !row.kitchenChannelId) continue;
      const scope = `kitchen-chart:${row.guildId}`;
      if (await seen.has(scope, week.mondayKey)) continue;

      const guild =
        this.client.guilds.cache.get(row.guildId) ??
        (await this.client.guilds.fetch(row.guildId).catch(() => null));
      if (!guild) continue;
      const channel = await resolveGuildSendableChannel(
        this.client,
        row.kitchenChannelId,
        row.guildId,
      );
      if (!channel) {
        this.logger.warn(`Kitchen chart: channel missing in ${guild.name}.`);
        continue;
      }

      const caught = await this.catches.between(row.guildId, week.from, week.to);
      const songs = rankCatches(caught, (userId) => {
        const member = guild.members.cache.get(userId);
        return member ? displayName(member) : '';
      });

      let night: { counts: VoteCounts; winnerName?: string } | undefined;
      if (row.radioNightEnabled) {
        const counts = await this.votes.counts(row.guildId, week.fridayKey);
        const total = counts.kiss + counts.rock + counts.beat;
        if (total > 0) {
          const playedId = await radioNightPlayedStation(row.guildId, week.fridayKey);
          const winner = playedId ? getStation(playedId) : undefined;
          night = { counts, winnerName: winner?.name };
        }
      }

      const display = buildKitchenChartDisplay({ weekLabel: week.label, songs, night });
      try {
        await channel.send({
          components: display.components,
          flags: display.flags,
          files: display.files,
        });
        await seen.add(scope, [week.mondayKey]);
        this.logger.info(`Kitchen chart posted in ${guild.name}.`);
      } catch (error) {
        this.logger.error(`Kitchen chart failed in ${guild.name}:`, error);
      }
    }
  }

  private async startRadioNight(
    guildId: string,
    voiceChannelId: string,
    station: RadioStation,
    counts: { kiss: number; rock: number; beat: number } | null = null,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;
    const raw =
      guild.channels.cache.get(voiceChannelId) ??
      (await guild.channels.fetch(voiceChannelId).catch(() => null));
    if (!raw || !raw.isVoiceBased()) {
      this.logger.warn(`Radio Night: voice channel ${voiceChannelId} missing in ${guild.name}.`);
      return false;
    }
    const channel = raw as VoiceBasedChannel;
    const blocked = missingVoicePermissions(channel);
    if (blocked) {
      this.logger.warn(`Radio Night: ${blocked} (${guild.name})`);
      return false;
    }

    const already =
      this.radio.isLive(guildId) &&
      this.radio.channelId(guildId) === channel.id &&
      this.radio.station(guildId)?.id === station.id;

    if (!already) {
      if (!this.radio.isPlaying(guildId)) {
        this.music.get(guildId)?.stop();
      }
      await this.radio.play(channel, station);
    }

    this.refresh(guildId);

    const settings = await this.guildSettings.get(guildId);
    if (settings.kitchenEnabled && settings.kitchenChannelId) {
      const text = await resolveGuildSendableChannel(
        this.client,
        settings.kitchenChannelId,
        guildId,
      );
      const tally =
        counts && counts.kiss + counts.rock + counts.beat > 0
          ? ` Vote: Kiss ${counts.kiss} · Rock ${counts.rock} · Beat ${counts.beat}.`
          : '';
      await text
        ?.send({
          content: `🍪 **Radio Night** — **${station.name}** is live in **#${channel.name}**. Hop in.${tally}`,
        })
        .catch(() => {});
    }
    return true;
  }

  /** One push per guild at a time, so a tick and a refresh cannot both post a board. */
  private push(guildId: string): Promise<void> {
    const previous = this.inFlight.get(guildId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.pushNow(guildId));
    this.inFlight.set(guildId, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.inFlight.get(guildId) === next) this.inFlight.delete(guildId);
      });
    return next;
  }

  private async pushNow(guildId: string): Promise<void> {
    const settings = await this.guildSettings.get(guildId);
    if (!settings.kitchenEnabled || !settings.kitchenChannelId) return;

    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;

    const channel = await resolveGuildSendableChannel(
      this.client,
      settings.kitchenChannelId,
      guildId,
    );
    if (!channel || !channel.isTextBased()) return;

    const view = await this.buildView(
      guild,
      settings.kitchenJoinDate,
      settings.kitchenJoinCount,
      settings,
    );
    const key = kitchenViewKey(view);
    const display = buildKitchenBoardDisplay(view);
    // `attachments: []` drops the previous upload so the kitchen photos never pile up.
    const edit = {
      embeds: [] as [],
      components: display.components,
      flags: display.flags,
      files: display.files,
      attachments: [] as [],
    };

    let legacy: Message | null = null;
    if (settings.kitchenMessageId) {
      try {
        // Usually a cache hit. A deleted board fails here or on edit and is re-posted below.
        const existing = await channel.messages.fetch(settings.kitchenMessageId);
        if (isComponentsV2(existing)) {
          if (this.lastKey.get(guildId) === key) return;
          await existing.edit(edit);
          this.lastKey.set(guildId, key);
          return;
        }
        legacy = existing;
      } catch (error) {
        // Only a deleted board is replaced. A rate limit or outage must not post a second one.
        if (!isUnknownMessage(error)) throw error;
        await this.guildSettings.upsert(guildId, { kitchenMessageId: null });
      }
    }

    const recovered = legacy ?? (await this.findExistingBoard(channel));
    if (recovered && isComponentsV2(recovered)) {
      if (this.lastKey.get(guildId) !== key) await recovered.edit(edit);
      await this.guildSettings.upsert(guildId, { kitchenMessageId: recovered.id });
      this.lastKey.set(guildId, key);
      return;
    }

    const sent = await channel.send({
      components: display.components,
      flags: display.flags,
      files: display.files,
    });
    await this.guildSettings.upsert(guildId, { kitchenMessageId: sent.id });
    this.lastKey.set(guildId, key);
    if (recovered) {
      // An embed board from the short-lived website layout. Cards replace it once.
      await recovered.delete().catch(() => {});
      this.logger.info(`Kitchen board reposted as cards in ${guild.name}.`);
      return;
    }
    this.logger.info(`Kitchen board posted in ${guild.name}.`);
  }

  private async findExistingBoard(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await channel.messages.fetch({ limit: 30 });
      const mine = [...recent.values()]
        .filter((msg) => msg.author.id === this.client.user?.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      return mine.find((msg) => looksLikeKitchenBoard(collectMessageTextContent(msg))) ?? null;
    } catch {
      return null;
    }
  }

  private async buildView(
    guild: Guild,
    joinDate: string | null,
    joinCount: number,
    settings: {
      radioNightEnabled: boolean;
      radioNightChannelId: string | null;
      radioNightStation: string | null;
    },
  ): Promise<KitchenBoardView> {
    const today = calendarDate(this.config.timezone);
    const joinsToday = joinDate === today ? joinCount : 0;
    const stereo = this.stereoFor(guild.id);
    const voice = this.voiceSnapshot(guild);
    const steamSnap = this.steamByGuild.get(guild.id);
    const epicSnap = this.epicByGuild.get(guild.id);
    const nightStation = settings.radioNightEnabled
      ? getStation(settings.radioNightStation ?? '')
      : undefined;
    const nightChannel = settings.radioNightChannelId
      ? guild.channels.cache.get(settings.radioNightChannelId)
      : undefined;

    let radioVote: KitchenBoardView['radioVote'];
    if (
      settings.radioNightEnabled &&
      settings.radioNightChannelId &&
      isRadioVoteOpen(this.config.timezone)
    ) {
      const weekKey = radioNightWeekKey(this.config.timezone);
      const counts = await this.votes.counts(guild.id, weekKey);
      const closes = zonedDateTimeToUtc(this.config.timezone, weekKey, RADIO_VOTE_END_HOUR, 0);
      radioVote = {
        counts,
        total: counts.kiss + counts.rock + counts.beat,
        closesAt: Math.floor(closes.getTime() / 1000),
      };
    }

    const caught = await this.catches.latest(guild.id);
    const catcher = caught ? guild.members.cache.get(caught.userId) : undefined;

    return {
      stereo,
      listeners: voice.listeners,
      voiceChannelName: voice.name,
      steam: steamTeaser(steamSnap),
      epic: epicTeaser(epicSnap),
      joinsToday,
      radioNight: nightStation
        ? { stationName: nightStation.name, channelName: nightChannel?.name }
        : undefined,
      radioVote,
      latestCatch: caught
        ? {
            userId: caught.userId,
            title: caught.title,
            artist: caught.artist,
            by: catcher ? displayName(catcher) : 'Someone',
            coverUrl: caught.coverUrl ?? undefined,
            stationName: getStation(caught.stationId)?.name,
          }
        : undefined,
    };
  }

  private stereoFor(guildId: string): KitchenBoardView['stereo'] {
    const radioSession = this.radio.get(guildId);
    if (radioSession && this.radio.isPlaying(guildId)) {
      const station = radioSession.station;
      const track = radioSession.nowPlaying;
      const title = track?.title?.trim() || 'Live stream';
      const artist = track?.artist?.trim() || '';
      return {
        kind: 'radio',
        title,
        artist,
        sourceLabel: station.name,
        color: station.color,
        websiteUrl: station.websiteUrl,
        tagline: station.slogan,
        artUrl: track?.coverUrl,
        logoUrl: station.logoUrl,
      };
    }

    const player = this.music.get(guildId);
    const track = player?.current;
    if (player && track) {
      const sourceLabel =
        track.source === 'spotify' ? 'Spotify' : track.source === 'youtube' ? 'YouTube' : 'Music';
      return {
        kind: 'music',
        title: track.title,
        artist: track.uploader ?? 'Unknown artist',
        sourceLabel,
        titleUrl: track.sourceUrl || track.url,
        color: track.source === 'spotify' ? 0x1db954 : 0xff0000,
        paused: player.paused,
        artUrl: track.thumbnail,
        durationSec: track.durationSec > 0 ? track.durationSec : undefined,
        queueLength: upcomingQueue(track, player.queue).length,
        requestedBy: track.requestedBy,
      };
    }

    return {
      kind: 'quiet',
      title: 'The Kitchen',
      artist: 'Nothing on.',
      sourceLabel: 'The Kitchen',
      color: KITCHEN_COLOR,
    };
  }

  private voiceSnapshot(guild: Guild): {
    name?: string;
    listeners: { id: string; name: string }[];
  } {
    const guildId = guild.id;
    const channelId =
      this.radio.channelId(guildId) ??
      this.music.get(guildId)?.connection.joinConfig.channelId ??
      null;
    if (!channelId) return { listeners: [] };
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return { listeners: [] };
    const listeners = [...channel.members.values()]
      .filter((member) => !member.user.bot)
      .map((member) => ({ id: member.id, name: displayName(member) }));
    return { name: channel.name, listeners };
  }
}

function pickStationId(value: string | null | undefined): StationId | null {
  if (value && isStationId(value)) return value;
  return null;
}

/** The deal of the day: its art, the price line from the digest, and where the other nine are. */
function steamTeaser(snap: SteamSnapshot | undefined): KitchenDealTeaser | undefined {
  const item = snap?.items[0];
  if (!snap || !item) return undefined;
  const more = snap.items.length - 1;
  const rest =
    more > 0 ? `+${more} more ${snap.channelId ? `in <#${snap.channelId}>` : 'on the shelf'}` : '';
  return {
    kicker: '💸 STEAM DEAL OF THE DAY',
    title: item.gameName,
    line: steamMoneyLine(steamPriceBits(item, snap.prices.get(item.id) ?? null)) || 'On sale',
    note: [steamReviewChip(snap.reviews.get(item.id)), steamSaleEnds(item.expires), rest]
      .filter(Boolean)
      .join(' · '),
    url: item.link,
    image: item.image,
  };
}

/** This week's freebie with its countdown, or the next one when nothing is free. */
function epicTeaser(snap: EpicSnapshot | undefined): KitchenDealTeaser | undefined {
  const free = snap?.games.filter((g) => !g.isUpcoming) ?? [];
  const soon = snap?.games.filter((g) => g.isUpcoming) ?? [];
  const lead = free[0] ?? soon[0];
  if (!snap || !lead) return undefined;
  const worth = epicWorth(lead.originalPrice);
  const where = snap.channelId ? `<#${snap.channelId}>` : '';

  if (lead.isUpcoming) {
    const unlocks = discordTime(lead.upcomingStartDate, 'R');
    return {
      kicker: '🔜 NEXT FREE ON EPIC',
      title: lead.title,
      line: [unlocks ? `🔓 Free ${unlocks}` : '🔓 Free soon', worth ? `worth ${worth}` : '']
        .filter(Boolean)
        .join(' · '),
      note: where,
      url: lead.storeUrl,
      image: lead.image ?? lead.heroImage,
    };
  }

  const ends = discordTime(lead.endDate, 'R');
  const next = soon[0];
  const nextUp = next
    ? `next up: ${linkText(next.title, 40)} ${discordTime(next.upcomingStartDate, 'R')}`.trim()
    : '';
  return {
    kicker: '🎁 FREE ON EPIC THIS WEEK',
    title: lead.title,
    line: `**🆓 FREE**${worth ? ` ~~${worth}~~` : ''}${ends ? ` · ⏳ ends ${ends}` : ''}`,
    note: [free.length > 1 ? `+${free.length - 1} more free` : '', nextUp, where]
      .filter(Boolean)
      .join(' · '),
    url: lead.storeUrl,
    image: lead.image ?? lead.heroImage,
  };
}

function isComponentsV2(message: Message): boolean {
  return message.flags.has(MessageFlags.IsComponentsV2);
}

function missingVoicePermissions(channel: VoiceBasedChannel): string | null {
  const me = channel.guild.members.me;
  if (!me) return 'Could not resolve bot member.';
  const perms = channel.permissionsFor(me);
  if (!perms) return 'Could not read voice permissions.';
  if (!perms.has(PermissionFlagsBits.ViewChannel)) return 'Missing View Channel.';
  if (!perms.has(PermissionFlagsBits.Connect)) return 'Missing Connect.';
  if (!perms.has(PermissionFlagsBits.Speak)) return 'Missing Speak.';
  if (channel.userLimit > 0 && channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) {
    return 'Voice channel is full.';
  }
  if (channel.type === ChannelType.GuildStageVoice) return 'Stage channels are not supported.';
  return null;
}
