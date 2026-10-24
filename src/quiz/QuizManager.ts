import {
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type Message,
  type SendableChannels,
  type VoiceBasedChannel,
} from 'discord.js';
import type { V2Display } from '../core/display/v2';
import { buildReplyEmbed, type ReplyTone } from '../core/embeds';
import type { Logger } from '../core/logger';
import type { RadioCatchStore } from '../kitchen/catches';
import type { MusicManager } from '../music/MusicManager';
import { isSpotifyAlbumUrl, isSpotifyPlaylistUrl } from '../music/sources';
import type { RadioManager } from '../radio/RadioManager';
import { parseQuizButton } from './display';
import { QuizSession } from './QuizSession';
import { QUIZ_CHOICES, dedupeSongs, songFromCatch, songFromTrack, type QuizSong } from './songs';
import type { PlayedTrackStore, QuizScoreStore } from './stores';

/** A Spotify playlist matches each song on YouTube; the quiz starts with what arrived by then. */
const PLAYLIST_WAIT_MS = 40_000;

export interface QuizPool {
  songs: QuizSong[];
  /** "23 kitchen songs" or "the playlist (40 songs)". */
  source: string;
}

export interface QuizStartOptions {
  voice: VoiceBasedChannel;
  text: SendableChannels;
  starterId: string;
  rounds: number;
  pool: QuizPool;
  /** Writes the lobby into the deferred /quiz reply. A new message otherwise. */
  postLobby?: (display: V2Display) => Promise<Message>;
}

/** One Kitchen Quiz per server. Music and radio step aside while it runs. */
export class QuizManager {
  private readonly sessions = new Map<string, QuizSession>();
  private readonly lastGame = new Map<string, { pool: QuizPool; rounds: number }>();

  constructor(
    private readonly music: MusicManager,
    private readonly radio: RadioManager,
    private readonly played: PlayedTrackStore,
    private readonly catches: RadioCatchStore,
    private readonly scores: QuizScoreStore,
    private readonly logger: Logger,
  ) {}

  isActive(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  get(guildId: string): QuizSession | undefined {
    return this.sessions.get(guildId);
  }

  /** The kitchen's own songs: everything /play'ed and every 🍪 catch. */
  async kitchenPool(guildId: string): Promise<QuizPool> {
    const [plays, caught] = await Promise.all([
      this.played.all(guildId),
      this.catches.between(guildId, new Date(0), new Date()),
    ]);
    const songs = dedupeSongs([
      ...plays.map((row) =>
        songFromTrack(
          {
            title: row.title,
            url: row.url,
            uploader: row.uploader ?? undefined,
            durationSec: row.durationSec,
            thumbnail: row.thumbnail ?? undefined,
          },
          { kind: 'play', userId: row.requestedById ?? undefined },
        ),
      ),
      ...caught.map(songFromCatch),
    ]);
    return { songs, source: `${songs.length} kitchen songs` };
  }

  /** A YouTube or Spotify playlist or album. Spotify songs keep arriving after the quiz starts. */
  async playlistPool(url: string): Promise<QuizPool> {
    const songs: QuizSong[] = [];
    const add = (tracks: Parameters<typeof songFromTrack>[0][]) => {
      const fresh = dedupeSongs([
        ...songs,
        ...tracks.map((track) => songFromTrack(track, { kind: 'playlist' })),
      ]).slice(songs.length);
      songs.push(...fresh);
    };
    const source = this.music.trackSource;
    if (isSpotifyPlaylistUrl(url) || isSpotifyAlbumUrl(url)) {
      const loading = source.resolveProgressive(url, 'Kitchen Quiz', add).catch((error) => {
        this.logger.warn('Kitchen Quiz: Spotify playlist failed:', error);
        return null;
      });
      await Promise.race([
        loading,
        new Promise((resolve) => setTimeout(resolve, PLAYLIST_WAIT_MS)),
      ]);
    } else {
      add(await source.resolve(url, 'Kitchen Quiz'));
    }
    return { songs, source: 'from the playlist' };
  }

  async start(options: QuizStartOptions): Promise<QuizSession> {
    const guild = options.voice.guild;
    if (this.sessions.has(guild.id)) throw new Error('A quiz is already running here.');
    if (options.pool.songs.length < QUIZ_CHOICES) {
      throw new Error(
        `The quiz needs at least ${QUIZ_CHOICES} songs and found ${options.pool.songs.length}.`,
      );
    }
    this.music.get(guild.id)?.stop();
    this.radio.stop(guild.id);

    const rounds = Math.min(options.rounds, options.pool.songs.length);
    const session = new QuizSession(
      {
        guildId: guild.id,
        guildName: guild.name,
        voice: options.voice,
        text: options.text,
        starterId: options.starterId,
        rounds,
        pool: options.pool.songs,
        source: options.pool.source,
      },
      this.music.trackSource,
      this.scores,
      this.logger,
      () => {
        if (this.sessions.get(guild.id) === session) this.sessions.delete(guild.id);
      },
    );
    this.sessions.set(guild.id, session);
    this.lastGame.set(guild.id, { pool: options.pool, rounds: options.rounds });
    try {
      await session.open(options.postLobby);
    } catch (error) {
      this.sessions.delete(guild.id);
      throw error;
    }
    return session;
  }

  stop(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.stop();
    return true;
  }

  stopAll(): void {
    for (const session of [...this.sessions.values()]) session.stop();
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseQuizButton(interaction.customId);
    const guildId = interaction.guildId;
    if (!parsed || !guildId) return;
    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const session = this.sessions.get(guildId);
    const live = session && session.id === parsed.session ? session : undefined;

    if (parsed.kind === 'again') {
      await this.playAgain(interaction, member);
      return;
    }
    if (!live) {
      await this.whisper(interaction, 'info', 'That quiz is over.');
      return;
    }
    if (member?.voice.channelId !== live.voiceChannelId) {
      await this.whisper(interaction, 'warn', `🔇 Join <#${live.voiceChannelId}> to play.`);
      return;
    }
    if (parsed.kind === 'start') {
      await interaction.deferUpdate();
      live.begin();
      return;
    }
    if (parsed.kind === 'stop') {
      await interaction.deferUpdate();
      live.stop();
      return;
    }
    if (parsed.kind !== 'answer') return;
    const result = live.answer(interaction.user.id, parsed.round, parsed.choice);
    const letter = 'ABCD'[parsed.choice];
    if (result === 'locked')
      await this.whisper(interaction, 'success', `🔒 Locked in **${letter}**.`);
    else if (result === 'again') await this.whisper(interaction, 'info', 'One answer per round.');
    else await this.whisper(interaction, 'info', 'That round is over.');
  }

  private async playAgain(
    interaction: ButtonInteraction,
    member: GuildMember | null,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const last = this.lastGame.get(guildId);
    const voice = member?.voice.channel;
    const text = interaction.channel?.isSendable() ? interaction.channel : null;
    if (this.sessions.has(guildId)) {
      await this.whisper(interaction, 'info', 'A quiz is already running.');
      return;
    }
    if (!last || !voice || !text) {
      await this.whisper(interaction, 'warn', '🔇 Join a voice channel, then `/quiz start`.');
      return;
    }
    await interaction.deferUpdate();
    await this.start({
      voice,
      text,
      starterId: interaction.user.id,
      rounds: last.rounds,
      pool: last.pool,
    }).catch(async (error: unknown) => {
      this.logger.warn('Kitchen Quiz: play again failed:', error);
      await this.whisper(
        interaction,
        'error',
        `❌ ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  private async whisper(
    interaction: ButtonInteraction,
    tone: ReplyTone,
    description: string,
  ): Promise<void> {
    const payload = {
      embeds: [buildReplyEmbed(tone, description)],
      flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  }
}
