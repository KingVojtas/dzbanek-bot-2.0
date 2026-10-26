import type { Guild, GuildMember, SendableChannels, VoiceBasedChannel } from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { RadioCatchStore } from '../kitchen/catches';
import type { MusicManager } from '../music/MusicManager';
import { dedupeSongs, songFromCatch, songFromTrack } from '../quiz/songs';
import type { PlayedTrackStore } from '../quiz/stores';
import { FmStation } from './FmStation';
import type { FmSong } from './script';
import { DjVoice } from './voice';
import { DjWriter } from './writer';

/** Fewer kitchen songs than this and the station would repeat itself at once. */
export const FM_MIN_SONGS = 3;

/**
 * Kitchen FM: the server's own station. It plays the kitchen's songs (every
 * /play and every 🍪 catch) on the music player, and a DJ written by Claude
 * introduces each one. /play requests still go first.
 */
export class KitchenFm {
  private readonly stations = new Map<string, FmStation>();
  private readonly writer: DjWriter;
  private readonly voice: DjVoice;

  constructor(
    private readonly music: MusicManager,
    private readonly played: PlayedTrackStore,
    private readonly catches: RadioCatchStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.writer = new DjWriter(config.dj.model, logger);
    this.voice = new DjVoice(config.dj.voice, logger);
  }

  isOn(guildId: string): boolean {
    return this.stations.has(guildId);
  }

  /** Every song the kitchen played or caught, newest plays first. A play beats a catch of the same song. */
  async pool(guildId: string): Promise<FmSong[]> {
    const [plays, caught] = await Promise.all([
      this.played.all(guildId),
      this.catches.between(guildId, new Date(0), new Date()),
    ]);
    return dedupeSongs<FmSong>([
      ...plays.map((row) => ({
        ...songFromTrack(
          {
            title: row.title,
            url: row.url,
            uploader: row.uploader ?? undefined,
            durationSec: row.durationSec,
            thumbnail: row.thumbnail ?? undefined,
          },
          { kind: 'play', userId: row.requestedById ?? undefined },
        ),
        at: row.playedAt,
        videoTitle: row.title,
        uploader: row.uploader ?? undefined,
      })),
      ...caught.map((row) => ({
        ...songFromCatch(row),
        at: row.caughtAt,
        stationId: row.stationId,
      })),
    ]);
  }

  /**
   * Join `voice` and go on air. Music already playing carries on, and the
   * station takes over when its queue ends. Returns how many songs it has.
   */
  async start(voice: VoiceBasedChannel, text: SendableChannels | null): Promise<number> {
    const guild = voice.guild;
    const songs = (await this.pool(guild.id)).length;
    if (songs < FM_MIN_SONGS) {
      throw new Error(
        `Kitchen FM needs at least ${FM_MIN_SONGS} kitchen songs and found ${songs}. ` +
          '`/play` a few, or 🍪 Catch some off the radio.',
      );
    }

    const player = await this.music.join(voice);
    if (text) player.setAnnounceChannel(text);
    if (player.onAir && this.stations.has(guild.id)) return songs;

    const station: FmStation = new FmStation(
      {
        guild,
        listeners: () => this.listeners(guild),
        pool: () => this.pool(guild.id),
        source: this.music.trackSource,
        writer: this.writer,
        voice: this.voice,
        language: this.config.dj.language,
        timezone: this.config.timezone,
        logger: this.logger,
      },
      () => {
        if (this.stations.get(guild.id) === station) this.stations.delete(guild.id);
        this.logger.info(`Kitchen FM off the air in ${guild.name}.`);
      },
    );
    this.stations.set(guild.id, station);
    player.setStation(station);
    this.logger.info(`Kitchen FM on air in ${guild.name} (#${voice.name}), ${songs} songs.`);
    return songs;
  }

  /** End the show and leave voice. False when Kitchen FM was not on. */
  stop(guildId: string): boolean {
    const player = this.music.get(guildId);
    if (!this.stations.has(guildId) || !player?.onAir) return false;
    player.stop();
    return true;
  }

  /** People in the voice channel the bot is in now; someone may have moved it. */
  private listeners(guild: Guild): GuildMember[] {
    const channelId = this.music.get(guild.id)?.connection.joinConfig.channelId;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()].filter((member) => !member.user.bot);
  }
}
