import type { Guild, GuildMember, SendableChannels, VoiceBasedChannel } from 'discord.js';
import type { Config } from '../config';
import type { Logger } from '../core/logger';
import type { RadioCatchStore } from '../kitchen/catches';
import type { MusicManager } from '../music/MusicManager';
import type { Track } from '../core/types';
import { dedupeSongs, songFromCatch, songFromTrack } from '../quiz/songs';
import type { PlayLogKind, PlayedTrackStore } from '../quiz/stores';
import { createCatalog, type FmCatalog } from './catalog';
import { FmStation } from './FmStation';
import { GenreBook, genreCachePath } from './GenreBook';
import { genreName } from './genres';
import {
  playFromFire,
  reactionSongKey,
  type ReactionKind,
  type SongReactionStore,
} from './reactions';
import type { DjLanguage, FmSong } from './script';
import { DjVoice } from './voice';
import { DjWriter } from './writer';

/** Fewer kitchen songs than this and the station would repeat itself at once. */
export const FM_MIN_SONGS = 3;

/**
 * How a track start is filed. A new find wins over a plain station pick.
 * A dedication is a request the DJ was asked to introduce, not a station song.
 */
export function playLogKind(
  track: { stationPick?: boolean },
  about: { how: 'play' | 'catch' | 'new'; dedicated: boolean } | null,
): PlayLogKind {
  if (about?.how === 'new') return 'find';
  if (track.stationPick) return 'fm';
  if (about?.dedicated) return 'dedication';
  return 'play';
}

/**
 * Kitchen FM: the server's own station. It plays the kitchen's songs (every
 * /play and every 🍪 catch) in genre blocks of about ten songs, with a few new
 * finds and a DJ between the sets. /play requests still go first. No API key.
 */
export class KitchenFm {
  private readonly stations = new Map<string, FmStation>();
  private readonly writer: DjWriter;
  private readonly voice: DjVoice;
  private readonly genres: GenreBook;
  private readonly catalog: FmCatalog;

  constructor(
    private readonly music: MusicManager,
    private readonly played: PlayedTrackStore,
    private readonly catches: RadioCatchStore,
    private readonly reactions: SongReactionStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.writer = new DjWriter(config.dj.model, logger, {
      setsPerServerPerDay: config.dj.setsPerServerPerDay,
      setsPerDay: config.dj.setsPerDay,
      timezone: config.timezone,
    });
    this.voice = new DjVoice(config.dj.voice, logger);
    this.catalog = createCatalog();
    this.genres = new GenreBook(genreCachePath(), this.catalog, logger);
  }

  /** A set may bring songs the kitchen never played, from related artists. */
  get findsNew(): boolean {
    return this.config.dj.discover > 0;
  }

  /** The line book the DJ is speaking. Dedications use it for `{song}`. */
  get language(): DjLanguage {
    return this.config.dj.language;
  }

  /** English genre name for a song key, when the cache knows it. */
  genreOf(songKey: string): string | undefined {
    const id = this.genres.genreOf(songKey);
    return id ? genreName(id, 'en') : undefined;
  }

  /**
   * What the play log should store for a track that just started.
   * The station's pool key wins when the show handed the track out.
   */
  describe(
    guildId: string,
    track: Track,
  ): { key: string; kind: PlayLogKind; artist: string; title: string } {
    const song = songFromTrack(track, { kind: 'play' });
    const station = this.stations.get(guildId);
    const about = station?.aboutTrack(track) ?? null;
    const artist = (about?.artist.trim() ? about.artist : song.artist).slice(0, 200);
    const title = (about?.title.trim() ? about.title : song.title).slice(0, 300);
    return {
      key: station?.keyOf(track) || song.key,
      kind: playLogKind(track, about),
      artist,
      title,
    };
  }

  isOn(guildId: string): boolean {
    return this.stations.has(guildId);
  }

  /** Every song the kitchen played or caught, newest plays first. A play beats a catch of the same song. */
  async pool(guildId: string): Promise<FmSong[]> {
    const [plays, caught, tally] = await Promise.all([
      this.played.all(guildId),
      this.catches.between(guildId, new Date(0), new Date()),
      this.reactions.tally(guildId),
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
    ]).map((song) => {
      const heat = tally.fires.get(song.key) ?? 0;
      const nopes = tally.nopes.get(song.key) ?? 0;
      return heat || nopes ? { ...song, heat, nopes } : song;
    });
  }

  /**
   * Join `voice` and go on air. Music already playing carries on, and the
   * station takes over when its queue ends. Returns how many songs it has.
   */
  async start(voice: VoiceBasedChannel, text: SendableChannels | null): Promise<number> {
    const guild = voice.guild;
    const kitchen = await this.pool(guild.id);
    const songs = kitchen.length;
    if (songs < FM_MIN_SONGS) {
      throw new Error(
        `Kitchen FM needs at least ${FM_MIN_SONGS} kitchen songs and found ${songs}. ` +
          '`/play` a few, or 🍪 Catch some off the radio.',
      );
    }

    const player = await this.music.join(voice);
    if (text) player.setAnnounceChannel(text);
    this.genres.enqueue(kitchen);
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
        discover: this.config.dj.discover,
        blockSets: this.config.dj.blockSets,
        genres: this.genres,
        catalog: this.catalog,
        findBlocks: async () => (await this.reactions.tally(guild.id)).blocked,
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

  /**
   * Queue a dedication on the show that is on now. `track` null is read before
   * the next song. The clip starts here, before that song does.
   */
  dedicate(
    guildId: string,
    input: {
      userId: string;
      from: string;
      to: string;
      message: string;
      track: Track | null;
      song: string;
    },
  ): 'off' | 'ok' | 'yours' | 'full' {
    const station = this.stations.get(guildId);
    if (!station) return 'off';
    return station.dedicate(input);
  }

  /** Whether this person can send a dedication on the show that is on. */
  dedicationBlock(guildId: string, userId: string): 'off' | 'ok' | 'yours' | 'full' {
    const station = this.stations.get(guildId);
    if (!station) return 'off';
    return station.dedicationBlock(userId);
  }

  /** 🔥 or 👎 on the song that is on. Returns the 🔥 count after the press. */
  async react(guildId: string, userId: string, track: Track, kind: ReactionKind): Promise<number> {
    const song = songFromTrack(track, { kind: 'play' });
    const key = this.songKey(guildId, track);
    const result = await this.reactions.toggle(
      guildId,
      userId,
      { songKey: key, url: track.url, title: song.title, artist: song.artist },
      kind,
    );
    if (result.firstFire) {
      const known = await this.knows(guildId, key);
      const credit = playFromFire(track, userId, known, true);
      if (credit) await this.played.record(guildId, credit);
    }
    return result.fires;
  }

  /** 🔥 on the song that is on, for the Now Playing card. */
  async fires(guildId: string, track: Track): Promise<number> {
    const key = this.songKey(guildId, track);
    if (!key || key === '|') return 0;
    return this.reactions.fires(guildId, key);
  }

  /** The station's pool key when it handed this track out, otherwise the track's own. */
  private songKey(guildId: string, track: Track): string {
    return reactionSongKey(track, this.stations.get(guildId)?.keyOf(track) ?? null);
  }

  /** End the show and leave voice. False when Kitchen FM was not on. */
  stop(guildId: string): boolean {
    const player = this.music.get(guildId);
    if (!this.stations.has(guildId) || !player?.onAir) return false;
    player.stop();
    return true;
  }

  /** True when this song is already a kitchen play or a 🍪 catch. */
  private async knows(guildId: string, key: string): Promise<boolean> {
    const [plays, caught] = await Promise.all([
      this.played.all(guildId),
      this.catches.between(guildId, new Date(0), new Date()),
    ]);
    for (const row of plays) {
      const song = songFromTrack(
        {
          title: row.title,
          url: row.url,
          uploader: row.uploader ?? undefined,
          durationSec: row.durationSec,
          thumbnail: row.thumbnail ?? undefined,
        },
        { kind: 'play' },
      );
      if (song.key === key) return true;
    }
    return caught.some((row) => songFromCatch(row).key === key);
  }

  /** People in the voice channel the bot is in now; someone may have moved it. */
  private listeners(guild: Guild): GuildMember[] {
    const channelId = this.music.get(guild.id)?.connection.joinConfig.channelId;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()].filter((member) => !member.user.bot);
  }
}
