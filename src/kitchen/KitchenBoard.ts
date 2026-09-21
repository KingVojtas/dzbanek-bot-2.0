import {
  ChannelType,
  Events,
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
import { collectMessageTextContent } from '../core/display';
import { resolveGuildSendableChannel } from '../deals/targets';
import type { GuildSettingsStore } from '../deals/guild-settings';
import type { MusicManager } from '../music/MusicManager';
import type { RadioManager } from '../radio/RadioManager';
import { getStation, type RadioStation, type StationId } from '../radio/station';
import {
  KITCHEN_COLOR,
  buildKitchenBoardDisplay,
  kitchenViewKey,
  looksLikeKitchenBoard,
  type KitchenBoardView,
  type KitchenDealTeaser,
} from './display';
import { isRadioVoteOpen, radioNightWeekKey } from './time';
import { RadioNightVoteStore, isStationId } from './votes';

const TICK_MS = 20_000;
const DEBOUNCE_MS = 1_200;

interface SteamSnapshot {
  items: SteamDealItem[];
  prices: Map<string, string | null>;
  reviews: Map<string, string>;
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
  private readonly epicByGuild = new Map<string, EpicFreeGame[]>();
  private readonly lastKey = new Map<string, string>();
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly votes = new RadioNightVoteStore();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private presenceTick: (() => void) | null = null;

  constructor(
    private readonly client: Client,
    private readonly music: MusicManager,
    private readonly radio: RadioManager,
    private readonly guildSettings: GuildSettingsStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  setPresenceTick(fn: () => void): void {
    this.presenceTick = fn;
  }

  steamHeadline(): string | null {
    for (const snap of this.steamByGuild.values()) {
      const item = snap.items[0];
      if (!item) continue;
      const discount = item.discount?.replace(/[()]/g, '').trim();
      return discount ? `${item.gameName} on sale ${discount}` : item.gameName;
    }
    return null;
  }

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
      const channelIds = new Set(
        [oldState.channelId, newState.channelId, this.radio.channelId(guildId)].filter(Boolean),
      );
      if (channelIds.size === 0) return;
      this.refresh(guildId);
    });

    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.refreshAll();
    }, TICK_MS);
    this.tickTimer.unref?.();
  }

  recordSteam(
    guildId: string,
    items: SteamDealItem[],
    prices: Map<string, string | null>,
    reviews: Map<string, string>,
  ): void {
    this.steamByGuild.set(guildId, { items, prices, reviews });
  }

  recordEpic(guildId: string, games: EpicFreeGame[]): void {
    this.epicByGuild.set(guildId, games);
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
      const tieBreak = pickStationId(row.radioNightStation) ?? pickStationId(row.lastRadioStation) ?? 'beat';
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
        await this.startRadioNight(row.guildId, row.radioNightChannelId, station, total > 0 ? counts : null);
      } catch (error) {
        this.logger.error(`Radio Night failed in ${row.guildId}:`, error);
      }
    }
  }

  private async startRadioNight(
    guildId: string,
    voiceChannelId: string,
    station: RadioStation,
    counts: { kiss: number; rock: number; beat: number } | null = null,
  ): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;
    const raw =
      guild.channels.cache.get(voiceChannelId) ??
      (await guild.channels.fetch(voiceChannelId).catch(() => null));
    if (!raw || !raw.isVoiceBased()) {
      this.logger.warn(`Radio Night: voice channel ${voiceChannelId} missing in ${guild.name}.`);
      return;
    }
    const channel = raw as VoiceBasedChannel;
    const blocked = missingVoicePermissions(channel);
    if (blocked) {
      this.logger.warn(`Radio Night: ${blocked} (${guild.name})`);
      return;
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
    if (!settings.kitchenEnabled || !settings.kitchenChannelId) return;
    const text = await resolveGuildSendableChannel(
      this.client,
      settings.kitchenChannelId,
      guildId,
    );
    if (!text) return;
    const tally =
      counts && counts.kiss + counts.rock + counts.beat > 0
        ? ` Vote: Kiss ${counts.kiss} · Rock ${counts.rock} · Beat ${counts.beat}.`
        : '';
    await text
      .send({
        content: `🍪 **Radio Night** — **${station.name}** is live in **#${channel.name}**. Hop in.${tally}`,
      })
      .catch(() => {});
  }

  private async push(guildId: string): Promise<void> {
    const settings = await this.guildSettings.get(guildId);
    if (!settings.kitchenEnabled || !settings.kitchenChannelId) return;

    const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;

    const channel = await resolveGuildSendableChannel(
      this.client,
      settings.kitchenChannelId,
      guildId,
    );
    if (!channel || !channel.isTextBased()) return;

    const view = await this.buildView(guild, settings.kitchenJoinDate, settings.kitchenJoinCount, settings);
    const key = kitchenViewKey(view);
    const display = buildKitchenBoardDisplay(view);
    const payload = {
      embeds: [] as [],
      components: display.components,
      flags: display.flags,
      files: display.files ?? [],
    };

    if (settings.kitchenMessageId) {
      try {
        const existing = await channel.messages.fetch(settings.kitchenMessageId);
        if (this.lastKey.get(guildId) === key) return;
        await existing.edit(payload);
        this.lastKey.set(guildId, key);
        this.presenceTick?.();
        return;
      } catch {
        await this.guildSettings.upsert(guildId, { kitchenMessageId: null });
      }
    }

    const recovered = await this.findExistingBoard(channel);
    if (recovered) {
      if (this.lastKey.get(guildId) === key) {
        await this.guildSettings.upsert(guildId, { kitchenMessageId: recovered.id });
        return;
      }
      await recovered.edit(payload);
      await this.guildSettings.upsert(guildId, { kitchenMessageId: recovered.id });
      this.lastKey.set(guildId, key);
      this.presenceTick?.();
      return;
    }

    const sent = await channel.send({
      components: display.components,
      flags: display.flags,
      files: display.files ?? [],
    });
    await this.guildSettings.upsert(guildId, { kitchenMessageId: sent.id });
    this.lastKey.set(guildId, key);
    this.logger.info(`Kitchen board posted in ${guild.name}.`);
    this.presenceTick?.();
  }

  private async findExistingBoard(channel: SendableChannels): Promise<Message | null> {
    if (!channel.isTextBased()) return null;
    try {
      const recent = await channel.messages.fetch({ limit: 30 });
      const mine = [...recent.values()]
        .filter((msg) => msg.author.id === this.client.user?.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      return (
        mine.find((msg) => looksLikeKitchenBoard(collectMessageTextContent(msg))) ?? null
      );
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
    const epicGames = this.epicByGuild.get(guild.id) ?? [];
    const nightStation = settings.radioNightEnabled
      ? getStation(settings.radioNightStation ?? '')
      : undefined;

    let radioVote: KitchenBoardView['radioVote'];
    if (
      settings.radioNightEnabled &&
      settings.radioNightChannelId &&
      isRadioVoteOpen(this.config.timezone)
    ) {
      const counts = await this.votes.counts(guild.id, radioNightWeekKey(this.config.timezone));
      radioVote = {
        counts,
        total: counts.kiss + counts.rock + counts.beat,
      };
    }

    return {
      stereo,
      listeners: voice.listeners,
      voiceChannelName: voice.name,
      steam: steamTeaser(steamSnap),
      steamCount: steamSnap?.items.length ?? 0,
      epic: epicTeaser(epicGames),
      joinsToday,
      radioNight: nightStation ? { stationName: nightStation.name } : undefined,
      radioVote,
    };
  }

  private stereoFor(guildId: string): KitchenBoardView['stereo'] {
    const radioSession = this.radio.get(guildId);
    if (radioSession && this.radio.isPlaying(guildId)) {
      const station = radioSession.station;
      const track = radioSession.nowPlaying;
      const title = track?.title?.trim() || 'Live stream';
      const artist = track?.artist?.trim() || station.slogan;
      return {
        kind: 'radio',
        title,
        artist,
        sourceLabel: station.name,
        sourceUrl: station.websiteUrl,
        detail: station.slogan,
        heroUrl: track?.coverUrl || station.imageUrl,
        logoUrl: station.logoUrl,
        color: station.color,
        websiteUrl: station.websiteUrl,
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
        detail: player.paused ? '⏸️ Paused' : `Queue **${player.queue.length}**`,
        heroUrl: track.thumbnail,
        color: track.source === 'spotify' ? 0x1db954 : 0xff0000,
        paused: player.paused,
        queueLength: player.queue.length,
      };
    }

    return {
      kind: 'quiet',
      title: 'Oven’s off',
      artist: 'Drop `/radio play` or `/play` and I’ll put the kettle on.',
      sourceLabel: 'The Kitchen',
      color: KITCHEN_COLOR,
    };
  }

  private voiceSnapshot(guild: Guild): { name?: string; listeners: { id: string; name: string }[] } {
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

function steamTeaser(snap: SteamSnapshot | undefined): KitchenDealTeaser | undefined {
  const item = snap?.items[0];
  if (!item) return undefined;
  const discount = item.discount?.replace(/[()]/g, '').trim();
  const price = snap?.prices.get(item.id);
  const review = snap?.reviews.get(item.id);
  const extra = snap.items.length > 1 ? ` · ${snap.items.length} on sale` : '';
  const bits = [price, review].filter(Boolean);
  return {
    title: item.gameName,
    kicker: `${discount ? `STEAM · ${discount}` : 'STEAM'}${extra}`,
    line: bits.join(' · ') || 'On sale on Steam',
    url: item.link,
    image: item.image,
  };
}

function epicTeaser(games: EpicFreeGame[]): KitchenDealTeaser | undefined {
  const current = games.find((g) => !g.isUpcoming) ?? games[0];
  if (!current) return undefined;
  const line = current.isUpcoming
    ? 'Coming soon on the Epic Games Store'
    : current.originalPrice
      ? `~~${current.originalPrice}~~ → **FREE**`
      : '**FREE** this week';
  return {
    title: current.title,
    kicker: current.isUpcoming ? 'EPIC · Coming soon' : 'EPIC · Free now',
    line,
    url: current.storeUrl,
    image: current.image ?? current.heroImage,
  };
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
