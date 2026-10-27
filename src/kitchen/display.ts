import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { formatDuration } from '../core/embeds';
import { linkText } from '../core/display/text';
import type { V2Display } from '../core/display/v2';
import { STATION_LIST } from '../radio/station';
import { voteLeader, type VoteCounts } from './vote-tally';

export const KITCHEN_COLOR = 0xc4783a;
export const RADIO_NIGHT_CRON = '0 20 * * 5';
export const RADIO_NIGHT_LABEL = 'Friday 20:00';
export const RADIO_VOTE_PREFIX = 'kitchen:vote:';

/**
 * Music buttons on the board end in this. The handler acknowledges them and
 * redraws the board, instead of turning the board into a Now Playing card.
 */
export const KITCHEN_BUTTON_SUFFIX = ':board';

export const KITCHEN_HERO_FILE = 'kitchen-hero.jpg';
const THUMB_FILE = 'kitchen-thumb.jpg';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

export interface KitchenStereo {
  kind: 'radio' | 'music' | 'quiet';
  title: string;
  artist: string;
  sourceLabel: string;
  titleUrl?: string;
  color: number;
  websiteUrl?: string;
  /** The station's slogan, beside the live badge. */
  tagline?: string;
  /** Album cover or video art. */
  artUrl?: string;
  /** Station mark, for a song without a cover. */
  logoUrl?: string;
  paused?: boolean;
  durationSec?: number;
  /** Tracks after the current one. */
  queueLength?: number;
  requestedBy?: string;
}

export interface KitchenListener {
  id: string;
  name: string;
}

export interface KitchenVoiceMember {
  name: string;
  muted?: boolean;
  deafened?: boolean;
  streaming?: boolean;
  video?: boolean;
}

export interface KitchenVoiceRoom {
  name: string;
  members: KitchenVoiceMember[];
  /** The bot is in this one. */
  withBot?: boolean;
  afk?: boolean;
  /** Unix seconds when the first person sat down, when the bot saw it happen. */
  since?: number;
}

export interface KitchenDealTeaser {
  /** The small line above the title. */
  kicker: string;
  title: string;
  /** The price line. */
  line: string;
  /** A quiet line underneath: reviews, the countdown, where the rest are. */
  note?: string;
  url?: string;
  image?: string;
}

export interface KitchenBoardView {
  stereo: KitchenStereo;
  listeners: KitchenListener[];
  voiceChannelName?: string;
  /** Every voice channel with people in it that the board's readers can see. */
  voiceRooms: KitchenVoiceRoom[];
  steam?: KitchenDealTeaser;
  epic?: KitchenDealTeaser;
  joinsToday: number;
  radioNight?: { stationName: string; channelName?: string };
  /** `closesAt` is a Unix time in seconds, for a live countdown. */
  radioVote?: { counts: VoteCounts; total: number; closesAt?: number };
  latestCatch?: {
    userId: string;
    title: string;
    artist: string;
    by: string;
    coverUrl?: string;
    stationName?: string;
  };
  /** Who leads the chart week so far. Left out until someone has points. */
  chef?: { name: string; points: number };
}

export const CATCH_PLAY_PREFIX = 'kitchen:catch-play';

export interface KitchenDisplay extends V2Display {
  files: AttachmentBuilder[];
}

/** Bump when the layout changes so every board redraws once. */
const BOARD_LAYOUT = 'cards-room';

/** Pads the tally labels so the bars line up. */
export const VOTE_NAME_WIDTH = Math.max(...STATION_LIST.map((station) => station.voteName.length));

/** The kitchen photos ride along as attachments. A missing file just leaves the art out. */
export class KitchenFiles {
  private readonly used = new Map<string, AttachmentBuilder>();

  url(name: string): string | undefined {
    if (!this.used.has(name)) {
      const path = join(assetsDir, name);
      if (!existsSync(path)) return undefined;
      this.used.set(name, new AttachmentBuilder(path, { name }));
    }
    return `attachment://${name}`;
  }

  list(): AttachmentBuilder[] {
    return [...this.used.values()];
  }
}

function isLink(url: string | undefined): url is string {
  return Boolean(url && /^(https?:\/\/|attachment:\/\/)/i.test(url));
}

function linked(text: string, url: string | undefined): string {
  return url && /^https?:\/\//i.test(url) ? `[${text}](${url})` : text;
}

/** Text that sits inside bold, italics, or a heading. */
function plain(value: string, max: number): string {
  return value
    .replace(/[\r\n*`_~|#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function textBlock(lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.filter(Boolean).join('\n').slice(0, 4000));
}

/** A section needs a thumbnail or a button. Without art the text stands alone. */
function addArtBlock(
  container: ContainerBuilder,
  lines: string[],
  art: string | undefined,
  alt: string,
): void {
  const text = textBlock(lines);
  if (!isLink(art)) {
    container.addTextDisplayComponents(text);
    return;
  }
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(text)
      .setThumbnailAccessory(
        new ThumbnailBuilder().setURL(art).setDescription(alt.slice(0, 100) || 'Artwork'),
      ),
  );
}

function addBanner(container: ContainerBuilder, url: string | undefined, alt: string): void {
  if (!isLink(url)) return;
  container.addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(url).setDescription(alt.slice(0, 1024) || 'Artwork'),
    ),
  );
}

function divider(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true);
}

function button(
  id: string,
  label: string,
  emoji: string,
  style: ButtonStyle = ButtonStyle.Secondary,
): ButtonBuilder {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons);
}

/* ---------- The stereo ---------- */

function listenerLines(view: KitchenBoardView): string[] {
  if (!view.voiceChannelName) return [];
  const n = view.listeners.length;
  const who = n === 0 ? 'nobody listening yet' : n === 1 ? '1 listening' : `${n} listening`;
  const bits = [`🎧 **${plain(view.voiceChannelName, 60)}** · ${who}`];
  const queued = view.stereo.kind === 'music' ? (view.stereo.queueLength ?? 0) : 0;
  if (queued > 0) bits.push(`📜 ${queued} up next`);
  // The names are on the In voice card.
  return [bits.join(' · ')];
}

function quietStereo(files: KitchenFiles): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(KITCHEN_COLOR);
  addBanner(
    container,
    files.url(KITCHEN_HERO_FILE),
    'The Kitchen after dark: a jug, cookies, and tea',
  );
  container.addTextDisplayComponents(
    textBlock([
      '## 🍪 The Kitchen',
      '*The stereo is off and the kettle is warm.*',
      '-# 🎵 `/play` a song · 📻 `/radio play` a station',
    ]),
  );
  return container;
}

function radioStereo(view: KitchenBoardView): ContainerBuilder {
  const stereo = view.stereo;
  const container = new ContainerBuilder().setAccentColor(stereo.color);
  const tagline = stereo.tagline ? ` · *${plain(stereo.tagline, 60)}*` : '';
  const title = plain(stereo.title, 200) || 'Live stream';
  const artist = plain(stereo.artist, 120);
  addArtBlock(
    container,
    [
      `-# 🔴 LIVE · ${linked(plain(stereo.sourceLabel, 60), stereo.websiteUrl)}${tagline}`,
      `## ${title}`,
      artist && artist !== title ? `**${artist}**` : '',
      ...listenerLines(view),
    ],
    stereo.artUrl ?? stereo.logoUrl,
    artist ? `${artist} — ${title}` : title,
  );

  const buttons = [
    button('radio:catch', 'Catch', '🍪', ButtonStyle.Success),
    button('radio:stop', 'Stop', '⏹️', ButtonStyle.Danger),
  ];
  if (stereo.websiteUrl && /^https?:\/\//i.test(stereo.websiteUrl)) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Website')
        .setEmoji('🌐')
        .setURL(stereo.websiteUrl),
    );
  }
  container.addActionRowComponents(row(...buttons));
  return container;
}

function musicStereo(view: KitchenBoardView): ContainerBuilder {
  const stereo = view.stereo;
  const container = new ContainerBuilder().setAccentColor(stereo.color);
  const title = linkText(stereo.title, 200);
  addBanner(container, stereo.artUrl, title);

  const artist = plain(stereo.artist, 100);
  const length = stereo.durationSec ? `\`${formatDuration(stereo.durationSec)}\`` : '';
  const by = stereo.requestedBy ? `-# requested by ${plain(stereo.requestedBy, 40)}` : '';
  container.addTextDisplayComponents(
    textBlock([
      `-# ${stereo.paused ? '⏸️ PAUSED' : '🔊 NOW PLAYING'} · ${plain(stereo.sourceLabel, 30)}`,
      `## ${linked(title, stereo.titleUrl)}`,
      [artist ? `**${artist}**` : '', length].filter(Boolean).join(' · '),
      ...listenerLines(view),
      by,
    ]),
  );

  const toggle = stereo.paused
    ? button(`music:resume${KITCHEN_BUTTON_SUFFIX}`, 'Resume', '▶️', ButtonStyle.Success)
    : button(`music:pause${KITCHEN_BUTTON_SUFFIX}`, 'Pause', '⏸️');
  container
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        toggle,
        button(`music:skip${KITCHEN_BUTTON_SUFFIX}`, 'Skip', '⏭️'),
        button('music:queue', 'Queue', '📜'),
        button(`music:stop${KITCHEN_BUTTON_SUFFIX}`, 'Stop', '⏹️', ButtonStyle.Danger),
      ),
    );
  return container;
}

/* ---------- In voice ---------- */

const VOICE_ROOMS_MAX = 8;
const VOICE_NAMES_MAX = 12;

function people(n: number): string {
  return n === 1 ? '1 person' : `${n} people`;
}

function memberChip(member: KitchenVoiceMember): string {
  const icons = [
    member.streaming ? '🔴' : '',
    member.video ? '📹' : '',
    member.deafened ? '🔕' : member.muted ? '🔇' : '',
  ].join('');
  const name = plain(member.name, 32);
  return icons ? `${name} ${icons}` : name;
}

function voiceLegend(rooms: KitchenVoiceRoom[]): string {
  const everyone = rooms.flatMap((room) => room.members);
  return [
    everyone.some((m) => m.streaming) ? '🔴 streaming' : '',
    everyone.some((m) => m.video) ? '📹 camera' : '',
    everyone.some((m) => m.muted && !m.deafened) ? '🔇 muted' : '',
    everyone.some((m) => m.deafened) ? '🔕 deafened' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Who is in which call right now. Always on the board, even when the bot is not in voice. */
function voiceCard(view: KitchenBoardView): ContainerBuilder {
  const rooms = view.voiceRooms;
  const total = rooms.reduce((sum, room) => sum + room.members.length, 0);
  const lines = [total === 0 ? '### 🔊 In voice' : `### 🔊 In voice · ${people(total)}`];
  if (total === 0) {
    lines.push('-# Nobody’s in a call right now. Hop in, the kettle’s warm.');
  }
  for (const room of rooms.slice(0, VOICE_ROOMS_MAX)) {
    const icon = room.withBot ? '🎧' : room.afk ? '💤' : '🔊';
    const started = room.since ? ` · started <t:${room.since}:R>` : '';
    lines.push(`${icon} **${plain(room.name, 60)}** · ${people(room.members.length)}${started}`);
    const shown = room.members.slice(0, VOICE_NAMES_MAX).map(memberChip);
    const extra = room.members.length - shown.length;
    lines.push(`${shown.join(' · ')}${extra > 0 ? ` · +${extra}` : ''}`);
  }
  const hidden = rooms.length - VOICE_ROOMS_MAX;
  if (hidden > 0) lines.push(`-# +${hidden} more ${hidden === 1 ? 'call' : 'calls'}`);
  const legend = voiceLegend(rooms);
  if (legend) lines.push(`-# ${legend}`);
  return new ContainerBuilder()
    .setAccentColor(KITCHEN_COLOR)
    .addTextDisplayComponents(textBlock(lines));
}

/* ---------- The pantry ---------- */

function teaserLines(teaser: KitchenDealTeaser): string[] {
  return [
    `-# ${teaser.kicker}`,
    `### ${linked(linkText(teaser.title, 100), teaser.url)}`,
    teaser.line,
    teaser.note ? `-# ${teaser.note}` : '',
  ];
}

function pantryCard(view: KitchenBoardView): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(KITCHEN_COLOR)
    .addTextDisplayComponents(
      textBlock([
        '### 🛒 The Pantry',
        '-# Kitchen Board · the best deal today and this week’s freebie',
      ]),
    );
  if (!view.steam && !view.epic) {
    container.addTextDisplayComponents(
      textBlock(['-# 💸 Steam · the shelf is clear', '-# 🎁 Epic · nothing free this week']),
    );
    return container;
  }
  if (view.steam) {
    addArtBlock(container, teaserLines(view.steam), view.steam.image, view.steam.title);
  } else {
    container.addTextDisplayComponents(textBlock(['-# 💸 Steam · the shelf is clear']));
  }
  if (view.epic) {
    addArtBlock(container, teaserLines(view.epic), view.epic.image, view.epic.title);
  } else {
    container.addTextDisplayComponents(textBlock(['-# 🎁 Epic · nothing free this week']));
  }
  return container;
}

/* ---------- The room ---------- */

export function tallyBar(n: number, total: number): string {
  const width = 10;
  const filled = total > 0 ? Math.round((n / total) * width) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function voteLines(vote: NonNullable<KitchenBoardView['radioVote']>): string[] {
  const leader = voteLeader(vote.counts);
  const closes = vote.closesAt ? `<t:${vote.closesAt}:R>` : 'at 20:00';
  const lines = [`### 🌙 Radio Night · voting closes ${closes}`];
  for (const station of STATION_LIST) {
    const n = vote.counts[station.id];
    const label = `${station.emoji} ${station.voteName.padEnd(VOTE_NAME_WIDTH)}`;
    lines.push(
      `\`${label} ${tallyBar(n, vote.total)}\` **${n}**${station.id === leader ? ' 👑' : ''}`,
    );
  }
  const votes = vote.total === 1 ? '1 vote so far' : `${vote.total} votes so far`;
  lines.push(`-# One vote each, change it any time · ${votes}`);
  return lines;
}

/** One button per station, five to a row (Discord's cap). */
function voteButtons(counts: VoteCounts): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const leader = voteLeader(counts);
  const buttons = STATION_LIST.map((station) =>
    button(
      `${RADIO_VOTE_PREFIX}${station.id}`,
      `${station.voteName} · ${counts[station.id]}`,
      station.emoji,
      station.id === leader ? ButtonStyle.Success : ButtonStyle.Secondary,
    ),
  );
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  return rows;
}

function roomStatus(view: KitchenBoardView): string[] {
  const lines: string[] = [];
  if (view.joinsToday > 0) {
    const n = view.joinsToday;
    lines.push(`🍪 **${n}** ${n === 1 ? 'cookie' : 'cookies'} out of the jar today`);
  }
  if (view.radioNight && !view.radioVote) {
    const where = view.radioNight.channelName
      ? ` in 🔊 **${plain(view.radioNight.channelName, 60)}**`
      : '';
    lines.push(
      `🌙 **Radio Night** · ${RADIO_NIGHT_LABEL} · ${plain(view.radioNight.stationName, 40)}${where}`,
    );
  }
  if (view.chef && view.chef.points > 0 && view.chef.name.trim()) {
    const pts = view.chef.points === 1 ? '1 pt' : `${view.chef.points} pts`;
    lines.push(`👑 **${plain(view.chef.name, 32)}** is chef of the week so far · ${pts}`);
  }
  return lines;
}

/** Bottom card. Left out when the room has no catch, vote, cookies, chef, or Radio Night. */
function roomCard(view: KitchenBoardView, files: KitchenFiles): ContainerBuilder | null {
  const status = roomStatus(view);
  if (!view.latestCatch && !view.radioVote && status.length === 0) return null;
  const container = new ContainerBuilder().setAccentColor(KITCHEN_COLOR);

  if (view.latestCatch) {
    const caught = view.latestCatch;
    const title = plain(caught.title, 100);
    const artist = plain(caught.artist, 80);
    const station = caught.stationName ? ` · off ${plain(caught.stationName, 30)}` : '';
    const lines = [
      `-# 🎣 LATEST CATCH${station}`,
      `### ${title}`,
      artist && artist !== title ? `*${artist}*` : '',
      `-# caught by **${plain(caught.by, 32)}** · only they can press Play`,
    ];
    // A blank line where the divider between the catch and these lines was.
    if (status.length > 0) lines.push(`\n${status.join('\n')}`);
    addArtBlock(
      container,
      lines,
      caught.coverUrl ?? files.url(THUMB_FILE),
      artist ? `${artist} — ${title}` : title,
    );
    container.addActionRowComponents(
      row(button(CATCH_PLAY_PREFIX, 'Play it', '▶️', ButtonStyle.Primary)),
    );
  } else if (status.length > 0) {
    container.addTextDisplayComponents(textBlock(status));
  }

  if (view.radioVote) {
    // The vote heading is the break. A divider here put the full board over the cap.
    container.addTextDisplayComponents(textBlock(voteLines(view.radioVote)));
    container.addActionRowComponents(...voteButtons(view.radioVote.counts));
  }
  return container;
}

/** Always the last card: the kitchen's thank-you. */
function thanksCard(): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(KITCHEN_COLOR)
    .addTextDisplayComponents(textBlock(['💛 Thanks to **Sunka**']));
}

/**
 * The living Kitchen Board, in one message: the stereo with its controls, who
 * is in voice, the pantry with the top Steam deal and the Epic freebie, the
 * room with the latest catch, today's cookies, and Radio Night, and a thank-you.
 */
export function buildKitchenBoardDisplay(view: KitchenBoardView): KitchenDisplay {
  const files = new KitchenFiles();
  const stereo =
    view.stereo.kind === 'radio'
      ? radioStereo(view)
      : view.stereo.kind === 'music'
        ? musicStereo(view)
        : quietStereo(files);
  const components = [stereo, voiceCard(view), pantryCard(view)];
  const room = roomCard(view, files);
  if (room) components.push(room);
  components.push(thanksCard());
  return { components, flags: MessageFlags.IsComponentsV2, files: files.list() };
}

/** Everything the board shows. The same key means there is nothing to redraw. */
export function kitchenViewKey(view: KitchenBoardView): string {
  return `${BOARD_LAYOUT}|${JSON.stringify(view)}`;
}

/** The current board, or one from an older layout, which gets replaced. */
export function looksLikeKitchenBoard(blob: string): boolean {
  if (/kitchen board/i.test(blob) && /the pantry|radio night|in voice/i.test(blob)) return true;
  if (/\bin voice\b/i.test(blob) && /\bjoined today\b/i.test(blob)) return true;
  if (!/the kitchen/i.test(blob)) return false;
  if (/\bsteam\b/i.test(blob) && /\bepic\b/i.test(blob)) return true;
  return (
    /live stereo|oven’s off|quiet · the kitchen|on the stereo|jar’s full|cookies out of the jar/i.test(
      blob,
    ) || /● live|now playing/i.test(blob)
  );
}
