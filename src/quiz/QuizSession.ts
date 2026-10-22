import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Message, SendableChannels, VoiceBasedChannel } from 'discord.js';
import type { V2Display } from '../core/display';
import type { Logger } from '../core/logger';
import type { CompositeTrackSource } from '../music/sources';
import { prepareClip, type QuizClip } from './clip';
import {
  buildQuizLobbyDisplay,
  buildQuizNoticeDisplay,
  buildQuizPodiumDisplay,
  buildQuizRevealDisplay,
  buildQuizRoundDisplay,
  type QuizStanding,
} from './display';
import { QUIZ_ANSWER_MS, buildChoices, roundPoints, type QuizSong } from './songs';
import type { QuizScoreStore } from './stores';

const LOBBY_MS = 20_000;
const REVEAL_MS = 6_000;
const JOIN_TIMEOUT_MS = 20_000;
/** Songs tried for one round before the quiz gives up on finding a playable clip. */
const CLIP_TRIES = 4;
/** Answer-count edits on the round card, at most this often. */
const COUNT_EDIT_MS = 1_500;

export interface QuizSetup {
  guildId: string;
  guildName: string;
  voice: VoiceBasedChannel;
  text: SendableChannels;
  starterId: string;
  rounds: number;
  /** Shared with the loader: a Spotify playlist may still be adding songs. */
  pool: QuizSong[];
  source: string;
}

interface Round {
  number: number;
  song: QuizSong;
  labels: string[];
  correct: number;
  startedAt: number;
  answers: Map<string, { choice: number; ms: number }>;
}

interface Player {
  score: number;
  correct: number;
  streak: number;
  bestMs: number | null;
}

export type AnswerResult = 'locked' | 'again' | 'closed';

/** One game: lobby, rounds of clip → answers → reveal, then the podium. */
export class QuizSession {
  readonly id = Math.random().toString(36).slice(2, 8);
  /** `between` covers the wait for a clip, so a second Start press cannot start a second round. */
  private state: 'lobby' | 'between' | 'round' | 'reveal' | 'done' = 'lobby';
  private message: Message | null = null;
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer = createAudioPlayer();
  private readonly used = new Set<string>();
  private readonly players = new Map<string, Player>();
  private next: Promise<QuizClip | null> | null = null;
  private current: Round | null = null;
  private played = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private countEdit: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly setup: QuizSetup,
    private readonly source: CompositeTrackSource,
    private readonly scores: QuizScoreStore,
    private readonly logger: Logger,
    private readonly onEnd: () => void,
  ) {}

  get guildId(): string {
    return this.setup.guildId;
  }

  get voiceChannelId(): string {
    return this.setup.voice.id;
  }

  /** Read through a getter: `state` changes while a round awaits its clip. */
  private get over(): boolean {
    return this.state === 'done';
  }

  get inLobby(): boolean {
    return this.state === 'lobby';
  }

  /** Join voice, post the lobby, and start cutting the first clip. */
  async open(postLobby?: (display: V2Display) => Promise<Message>): Promise<Message> {
    getVoiceConnection(this.guildId)?.destroy();
    const connection = joinVoiceChannel({
      channelId: this.setup.voice.id,
      guildId: this.guildId,
      adapterCreator: this.setup.voice.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch (error) {
      connection.destroy();
      this.connection = null;
      throw new Error('Could not join the voice channel. Check **Connect** and **Speak**.', {
        cause: error,
      });
    }
    connection.subscribe(this.player);
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void entersState(connection, VoiceConnectionStatus.Connecting, 5_000).catch(() =>
        this.finish(true),
      );
    });
    this.player.on('error', (error) => this.logger.warn('Quiz audio error:', error));

    this.prefetch();
    const lobby = buildQuizLobbyDisplay({
      session: this.id,
      rounds: this.setup.rounds,
      source: this.setup.source,
      starterId: this.setup.starterId,
      voiceChannelId: this.setup.voice.id,
      startsAt: Date.now() + LOBBY_MS,
    });
    this.message = postLobby
      ? await postLobby(lobby)
      : await this.setup.text.send({ ...lobby, allowedMentions: { parse: [] } });
    this.timer = setTimeout(() => this.begin(), LOBBY_MS);
    this.logger.info(
      `Kitchen Quiz: ${this.setup.rounds} rounds from ${this.setup.pool.length} songs in ${this.setup.guildName}.`,
    );
    return this.message;
  }

  /** Lobby → round 1. A second call does nothing. */
  begin(): void {
    if (this.state !== 'lobby') return;
    this.state = 'between';
    this.clearTimer();
    void this.nextRound();
  }

  /** `/quiz stop`, the Cancel button, or an empty channel. */
  stop(): void {
    if (this.state === 'done') return;
    if (this.played === 0) {
      void this.close(buildQuizNoticeDisplay('🎧 Kitchen Quiz cancelled. Nothing was played.'));
      return;
    }
    void this.finish(true);
  }

  answer(userId: string, round: number, choice: number): AnswerResult {
    const current = this.current;
    if (this.state !== 'round' || !current || current.number !== round) return 'closed';
    if (current.answers.has(userId)) return 'again';
    current.answers.set(userId, { choice, ms: Date.now() - current.startedAt });
    if (current.answers.size >= this.listeners().length) {
      void this.reveal();
    } else {
      this.scheduleCountEdit();
    }
    return 'locked';
  }

  private listeners(): string[] {
    const channel = this.setup.voice.guild.channels.cache.get(this.setup.voice.id);
    if (!channel?.isVoiceBased()) return [];
    return [...channel.members.values()].filter((m) => !m.user.bot).map((m) => m.id);
  }

  private pickSong(): QuizSong | null {
    const left = this.setup.pool.filter((song) => !this.used.has(song.key));
    if (left.length === 0) return null;
    return left[Math.floor(Math.random() * left.length)]!;
  }

  private prefetch(): void {
    this.next = (async () => {
      for (let attempt = 0; attempt < CLIP_TRIES; attempt += 1) {
        const song = this.pickSong();
        if (!song) return null;
        this.used.add(song.key);
        try {
          return await prepareClip(song, this.source);
        } catch (error) {
          this.logger.warn(`Kitchen Quiz: skipped "${song.label}":`, error);
        }
      }
      return null;
    })();
  }

  private async nextRound(): Promise<void> {
    if (this.state === 'done') return;
    if (this.played >= this.setup.rounds) return this.finish(false);
    if (this.listeners().length === 0) return this.finish(true);

    const clip = await this.next;
    if (this.over) return;
    if (!clip) {
      this.logger.warn(`Kitchen Quiz: ran out of playable songs in ${this.setup.guildName}.`);
      return this.played > 0
        ? this.finish(true)
        : this.close(
            buildQuizNoticeDisplay(
              '🎧 None of these songs would play. Try `/quiz start playlist:`.',
            ),
          );
    }
    if (this.played + 1 < this.setup.rounds) this.prefetch();

    const { labels, correct } = buildChoices(this.setup.pool, clip.song);
    this.played += 1;
    this.player.play(createAudioResource(Readable.from([clip.pcm]), { inputType: StreamType.Raw }));
    await entersState(this.player, AudioPlayerStatus.Playing, 5_000).catch(() => {});
    this.current = {
      number: this.played,
      song: clip.song,
      labels,
      correct,
      startedAt: Date.now(),
      answers: new Map(),
    };
    this.state = 'round';
    await this.show(this.roundCard());
    this.timer = setTimeout(() => void this.reveal(), QUIZ_ANSWER_MS);
  }

  private roundCard(): V2Display {
    const current = this.current!;
    return buildQuizRoundDisplay({
      session: this.id,
      round: current.number,
      rounds: this.setup.rounds,
      labels: current.labels,
      closesAt: current.startedAt + QUIZ_ANSWER_MS,
      answered: current.answers.size,
      top: this.standings(),
    });
  }

  private scheduleCountEdit(): void {
    if (this.countEdit) return;
    this.countEdit = setTimeout(() => {
      this.countEdit = null;
      if (this.state === 'round') void this.show(this.roundCard());
    }, COUNT_EDIT_MS);
  }

  private async reveal(): Promise<void> {
    const current = this.current;
    if (this.state !== 'round' || !current) return;
    this.state = 'reveal';
    this.clearTimer();
    this.player.stop(true);

    const right = [...current.answers.entries()]
      .filter(([, answer]) => answer.choice === current.correct)
      .sort((a, b) => a[1].ms - b[1].ms);
    const winners = new Set(right.map(([userId]) => userId));
    for (const [userId, answer] of current.answers) {
      const player = this.players.get(userId) ?? { score: 0, correct: 0, streak: 0, bestMs: null };
      if (winners.has(userId)) {
        player.streak += 1;
        player.correct += 1;
        player.score += roundPoints(answer.ms, player.streak);
        player.bestMs = player.bestMs == null ? answer.ms : Math.min(player.bestMs, answer.ms);
      } else {
        player.streak = 0;
      }
      this.players.set(userId, player);
    }
    for (const [userId, player] of this.players) {
      if (!current.answers.has(userId)) player.streak = 0;
    }

    const last = this.played >= this.setup.rounds;
    const nextAt = last ? null : Date.now() + REVEAL_MS;
    const [first] = right;
    await this.show(
      buildQuizRevealDisplay({
        session: this.id,
        round: current.number,
        rounds: this.setup.rounds,
        labels: current.labels,
        correct: current.correct,
        song: current.song,
        winners: right.map(([userId]) => userId),
        fastest: first ? { userId: first[0], ms: first[1].ms } : undefined,
        top: this.standings(),
        nextAt,
      }),
    );
    this.timer = setTimeout(() => {
      if (last) return void this.finish(false);
      this.state = 'between';
      void this.nextRound();
    }, REVEAL_MS);
  }

  private standings(): QuizStanding[] {
    return [...this.players.entries()]
      .map(([userId, player]) => ({
        userId,
        score: player.score,
        correct: player.correct,
        bestMs: player.bestMs,
      }))
      .sort((a, b) => b.score - a.score || (a.bestMs ?? Infinity) - (b.bestMs ?? Infinity));
  }

  private async finish(stopped: boolean): Promise<void> {
    if (this.state === 'done') return;
    const standings = this.standings();
    await this.close(
      buildQuizPodiumDisplay({
        session: this.id,
        standings,
        played: this.played,
        rounds: this.setup.rounds,
        stopped,
      }),
    );
    await this.scores
      .save(
        this.guildId,
        this.played,
        standings.map(({ userId, score, correct }) => ({ userId, score, correct })),
      )
      .catch((error) => this.logger.error('Kitchen Quiz: saving scores failed:', error));
    this.logger.info(
      `Kitchen Quiz: finished ${this.played}/${this.setup.rounds} rounds in ${this.setup.guildName}.`,
    );
  }

  /** Last card, then leave voice and free the server for music and radio. */
  private async close(display: V2Display): Promise<void> {
    if (this.state === 'done') return;
    this.state = 'done';
    this.clearTimer();
    if (this.countEdit) clearTimeout(this.countEdit);
    this.player.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      /* already gone */
    }
    this.connection = null;
    this.onEnd();
    await this.show(display);
  }

  private async show(display: V2Display): Promise<void> {
    try {
      await this.message?.edit({ components: display.components, allowedMentions: { parse: [] } });
    } catch (error) {
      this.logger.debug('Kitchen Quiz: card edit failed:', error);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
