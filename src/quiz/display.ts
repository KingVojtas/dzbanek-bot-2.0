import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { V2Display } from '../core/display/v2';
import type { QuizSong } from './songs';

export const QUIZ_COLOR = 0x9b6bff;
export const QUIZ_BUTTON_PREFIX = 'quiz:';

const LETTERS = ['A', 'B', 'C', 'D'];
const MEDALS = ['🥇', '🥈', '🥉'];

export interface QuizStanding {
  userId: string;
  score: number;
  correct: number;
  /** Fastest right answer in ms. */
  bestMs: number | null;
}

export function answerId(session: string, round: number, choice: number): string {
  return `${QUIZ_BUTTON_PREFIX}${session}:a:${round}:${choice}`;
}

export function controlId(session: string, action: 'start' | 'stop' | 'again'): string {
  return `${QUIZ_BUTTON_PREFIX}${session}:${action}`;
}

/** `quiz:<session>:a:<round>:<choice>` or `quiz:<session>:<action>`. Null for anything else. */
export function parseQuizButton(
  customId: string,
):
  | { session: string; kind: 'answer'; round: number; choice: number }
  | { session: string; kind: 'start' | 'stop' | 'again' }
  | null {
  if (!customId.startsWith(QUIZ_BUTTON_PREFIX)) return null;
  const [session, kind, round, choice] = customId.slice(QUIZ_BUTTON_PREFIX.length).split(':');
  if (!session) return null;
  if (kind === 'a') {
    const r = Number(round);
    const c = Number(choice);
    if (!Number.isInteger(r) || !Number.isInteger(c) || c < 0 || c >= LETTERS.length) return null;
    return { session, kind: 'answer', round: r, choice: c };
  }
  if (kind === 'start' || kind === 'stop' || kind === 'again') return { session, kind };
  return null;
}

function text(lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.filter(Boolean).join('\n').slice(0, 3800));
}

function card(): ContainerBuilder {
  return new ContainerBuilder().setAccentColor(QUIZ_COLOR);
}

function done(container: ContainerBuilder): V2Display {
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function standingLines(top: QuizStanding[], limit: number): string[] {
  return top
    .filter((player) => player.score > 0)
    .slice(0, limit)
    .map(
      (player, i) =>
        `${MEDALS[i] ?? `${i + 1}.`} <@${player.userId}> **${player.score.toLocaleString('en-US')}**`,
    );
}

function answerRow(
  session: string,
  round: number,
  labels: string[],
  reveal?: { correct: number },
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    labels.map((label, i) => {
      const button = new ButtonBuilder()
        .setCustomId(answerId(session, round, i))
        .setLabel(`${LETTERS[i]} · ${label}`.slice(0, 80))
        .setStyle(reveal && i === reveal.correct ? ButtonStyle.Success : ButtonStyle.Secondary);
      return reveal ? button.setDisabled(true) : button;
    }),
  );
}

export function buildQuizLobbyDisplay(view: {
  session: string;
  rounds: number;
  source: string;
  starterId: string;
  voiceChannelId: string;
  startsAt: number;
}): V2Display {
  const container = card()
    .addTextDisplayComponents(
      text([
        '### 🎧 Kitchen Quiz',
        `**${view.rounds} rounds** of name that tune · ${view.source}`,
        `Hop into <#${view.voiceChannelId}>. Each round plays 15 s of a song; pick the right title. Faster answers score more.`,
        `-# Started by <@${view.starterId}> · begins <t:${Math.floor(view.startsAt / 1000)}:R>`,
      ]),
    )
    .addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(controlId(view.session, 'start'))
          .setLabel('Start now')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(controlId(view.session, 'stop'))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  return done(container);
}

export function buildQuizRoundDisplay(view: {
  session: string;
  round: number;
  rounds: number;
  labels: string[];
  closesAt: number;
  answered: number;
  top: QuizStanding[];
}): V2Display {
  const standings = standingLines(view.top, 3);
  const container = card()
    .addTextDisplayComponents(
      text([
        `### 🎧 Round ${view.round}/${view.rounds} · what's playing?`,
        `Answers close <t:${Math.floor(view.closesAt / 1000)}:R>`,
        `-# ${view.answered === 1 ? '1 answer' : `${view.answered} answers`} in · one try each`,
      ]),
    )
    .addActionRowComponents(answerRow(view.session, view.round, view.labels));
  if (standings.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text([`-# ${standings.join(' · ')}`]));
  }
  return done(container);
}

function sourceLine(song: QuizSong): string {
  if (song.from.kind === 'catch' && song.from.userId) return `🍪 caught by <@${song.from.userId}>`;
  if (song.from.kind === 'play' && song.from.userId) return `from <@${song.from.userId}>'s /play`;
  if (song.from.kind === 'playlist') return 'from the playlist';
  return '';
}

export function buildQuizRevealDisplay(view: {
  session: string;
  round: number;
  rounds: number;
  labels: string[];
  correct: number;
  song: QuizSong;
  winners: string[];
  fastest?: { userId: string; ms: number };
  top: QuizStanding[];
  nextAt: number | null;
}): V2Display {
  const { song } = view;
  const title = song.url ? `[${song.title.replace(/[[\]]/g, '')}](${song.url})` : song.title;
  const answer = text([
    `### ✅ ${LETTERS[view.correct]} · ${title}`,
    song.artist ? `by **${song.artist}**` : '',
    `-# ${[sourceLine(song), view.nextAt ? `next round <t:${Math.floor(view.nextAt / 1000)}:R>` : 'last round'].filter(Boolean).join(' · ')}`,
  ]);
  const container = card();
  if (song.thumbnail && /^https?:\/\//i.test(song.thumbnail)) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(answer)
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(song.thumbnail).setDescription(song.label.slice(0, 100)),
        ),
    );
  } else {
    container.addTextDisplayComponents(answer);
  }

  const who =
    view.winners.length === 0
      ? '😶 Nobody got it.'
      : `🎯 ${view.winners.map((id) => `<@${id}>`).join(', ')} got it`;
  const fastest = view.fastest
    ? `⚡ Fastest: <@${view.fastest.userId}> in ${seconds(view.fastest.ms)}`
    : '';
  const standings = standingLines(view.top, 3);
  container
    .addTextDisplayComponents(text([who, fastest]))
    .addActionRowComponents(answerRow(view.session, view.round, view.labels, view));
  if (standings.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text([`-# ${standings.join(' · ')}`]));
  }
  return done(container);
}

export function buildQuizPodiumDisplay(view: {
  session: string;
  standings: QuizStanding[];
  played: number;
  rounds: number;
  stopped: boolean;
}): V2Display {
  const ranked = view.standings.filter((player) => player.score > 0);
  const lines = ranked.slice(0, 10).map((player, i) => {
    const best = player.bestMs != null ? ` · ⚡ ${seconds(player.bestMs)}` : '';
    return `${MEDALS[i] ?? `${i + 1}.`} <@${player.userId}> **${player.score.toLocaleString('en-US')}** · ${player.correct}/${view.played}${best}`;
  });
  const champion = ranked[0];
  const container = card().addTextDisplayComponents(
    text([
      view.stopped ? '### 🏁 Kitchen Quiz · stopped early' : '### 🏁 Kitchen Quiz · final',
      champion
        ? `🏆 <@${champion.userId}> takes it with **${champion.score.toLocaleString('en-US')}** points.`
        : '😶 Nobody scored. The songs win this one.',
      '',
      ...lines,
      `-# ${view.played} of ${view.rounds} rounds played · scores count toward the Sunday postcard`,
    ]),
  );
  if (view.played > 0) {
    container.addActionRowComponents(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(controlId(view.session, 'again'))
          .setLabel('Play again')
          .setEmoji('🔁')
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }
  return done(container);
}

/** A plain one-liner card: the lobby was cancelled, or the quiz could not start. */
export function buildQuizNoticeDisplay(message: string): V2Display {
  return done(card().addTextDisplayComponents(text([message])));
}
