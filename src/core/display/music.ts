import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import {
  QUEUE_PAGE_SIZE,
  SITE_CLAY,
  buildSiteEmbed,
  formatClock,
  formatDuration,
  queueTotalPages,
  upcomingQueue,
  type EmbedCard,
  type SiteField,
} from '../embeds';
import type { LoopMode, Track } from '../types';
import { linkText, linked, plainBlurb } from './text';
import { thumbnailFor, type V2Display } from './v2';

const YOUTUBE_COLOR = 0xff0000;
const SPOTIFY_COLOR = 0x1db954;
const MUSIC_COLOR = 0x8b5cf6;

function musicAccent(source?: Track['source']): number {
  if (source === 'spotify') return SPOTIFY_COLOR;
  if (source === 'youtube') return YOUTUBE_COLOR;
  return MUSIC_COLOR;
}

function musicSourceLabel(source?: Track['source']): string {
  if (source === 'spotify') return 'Spotify';
  if (source === 'youtube') return 'YouTube';
  return 'Music';
}

function progressBar(positionSec: number, durationSec: number): string {
  const width = 14;
  if (durationSec <= 0) return '●' + '─'.repeat(width - 1);
  const ratio = Math.min(1, Math.max(0, positionSec / durationSec));
  const filled = Math.round(ratio * (width - 1));
  return '━'.repeat(filled) + '●' + '─'.repeat(Math.max(0, width - 1 - filled));
}

function upNextLine(count: number): string {
  return count > 0 ? `${count} up next` : 'Nothing up next';
}

/** A paused card goes grey, so it reads as stopped from across the chat. */
const PAUSED_COLOR = 0x8b93a7;

const LOOP_FOOTER: Record<LoopMode, string> = {
  off: '',
  track: '🔂 Repeating this track',
  queue: '🔁 Looping the queue',
};

function requesterOf(track: Track): string {
  return track.requestedById ? `<@${track.requestedById}>` : track.requestedBy;
}

/** Sum of the known lengths; `+` when some are unknown. */
function runtime(tracks: Track[]): string {
  const known = tracks.filter((track) => track.durationSec > 0);
  if (known.length === 0) return '';
  const total = known.reduce((sum, track) => sum + track.durationSec, 0);
  return `${formatClock(total)}${known.length < tracks.length ? '+' : ''}`;
}

export interface NowPlayingDisplayOptions {
  track: Track;
  /** Tracks after the current one. */
  queueLength: number;
  paused: boolean;
  loopMode: LoopMode;
  positionSec?: number;
  /** 1 = 100 %. */
  volume?: number;
  /** Enables ⏮ Previous. */
  hasHistory?: boolean;
  /** The track after this one, named on the card. */
  next?: Track | null;
}

/** Now Playing card, as on the website: who asked, the clock, the transport row. */
export function buildNowPlayingDisplay(opts: NowPlayingDisplayOptions): EmbedCard {
  const { track, queueLength, paused, loopMode } = opts;
  const positionSec = Math.max(0, opts.positionSec ?? 0);
  const durationSec = track.durationSec > 0 ? track.durationSec : 0;
  const volume = opts.volume ?? 1;
  const volumePct = Math.round(volume * 100);

  const artist = plainBlurb(track.uploader, 80);
  const description = [
    artist ? `by **${artist}**` : '',
    `\`${formatClock(positionSec)}\` ${progressBar(positionSec, durationSec)} \`${
      durationSec > 0 ? formatClock(durationSec) : 'Live'
    }\``,
  ]
    .filter(Boolean)
    .join('\n');

  // The edit ticker keeps this fresh; the relative half ticks on its own between edits.
  const endsAt = Math.floor(Date.now() / 1000 + Math.max(0, durationSec - positionSec));
  const timing: SiteField =
    !paused && durationSec > 0
      ? ['Ends', `<t:${endsAt}:t> · <t:${endsAt}:R>`]
      : ['Length', formatDuration(durationSec)];

  const next = opts.next;
  const upNext =
    loopMode === 'track'
      ? '🔂 This one again'
      : next
        ? [
            `${linked(linkText(next.title, 80), next.sourceUrl || next.url)} \`${formatDuration(next.durationSec)}\``,
            queueLength > 1 ? `and ${queueLength - 1} more` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : 'Nothing yet. `/play` adds more.';

  const footer = [upNextLine(queueLength), LOOP_FOOTER[loopMode]].filter(Boolean).join(' · ');

  const embed = buildSiteEmbed({
    color: paused ? PAUSED_COLOR : SITE_CLAY,
    author: `${paused ? '⏸️ Paused' : '🔊 Now Playing'} · ${musicSourceLabel(track.source)}`,
    title: track.title,
    url: track.sourceUrl || track.url,
    description,
    fields: [
      ['Requested by', requesterOf(track)],
      timing,
      ['Volume', `${volumePct < 100 ? '🔉' : '🔊'} ${volumePct}%`],
      ['Up next', upNext, true],
    ],
    footer,
    thumbnail: track.thumbnail,
  });

  const transport = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(paused ? 'music:resume' : 'music:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('music:skip')
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('music:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('music:loop')
      .setLabel(loopMode === 'off' ? 'Loop' : loopMode === 'track' ? 'Repeat' : 'Queue')
      .setEmoji(loopMode === 'track' ? '🔂' : '🔁')
      .setStyle(loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('music:shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary),
  );

  const extras = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('music:prev')
      .setLabel('Previous')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!opts.hasHistory),
    new ButtonBuilder()
      .setCustomId('music:voldown')
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volume <= 0.25),
    new ButtonBuilder()
      .setCustomId('music:volup')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(volume >= 1.5),
    new ButtonBuilder()
      .setCustomId('music:queue')
      .setLabel('Queue')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [transport, extras] };
}

/** Page buttons on the queue card. `queue:page:0` is the first page. */
export const QUEUE_BUTTON_PREFIX = 'queue:page:';

/** Queue card: what is on now, one numbered page of what follows, and the page buttons. */
export function buildQueueDisplay(current: Track | null, queue: Track[], page = 0): EmbedCard {
  const upcoming = upcomingQueue(current, queue);
  const totalPages = queueTotalPages(upcoming.length, QUEUE_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * QUEUE_PAGE_SIZE;
  const pageTracks = upcoming.slice(start, start + QUEUE_PAGE_SIZE);

  const lines: string[] = [];
  if (current) {
    const title = linkText(current.title, 200);
    lines.push(
      `🔊 **${linked(title, current.sourceUrl || current.url)}** \`${formatDuration(current.durationSec)}\``,
      `-# Requested by ${requesterOf(current)}`,
      '',
    );
  }
  if (pageTracks.length > 0) {
    const width = String(start + pageTracks.length).length;
    pageTracks.forEach((track, i) => {
      const title = linkText(track.title, 80);
      lines.push(
        `\`${String(start + i + 1).padStart(width)}.\` ${linked(title, track.sourceUrl || track.url)} \`${formatDuration(track.durationSec)}\` · ${requesterOf(track)}`,
      );
    });
  } else {
    lines.push('– Nothing up next. `/play` adds more.');
  }

  const total = runtime(upcoming);
  const embed = buildSiteEmbed({
    color: SITE_CLAY,
    author: '📜 Queue',
    title: [upNextLine(upcoming.length), total].filter(Boolean).join(' · '),
    description: lines.join('\n'),
    footer: `Page ${safePage + 1} of ${totalPages}`,
    thumbnail: current?.thumbnail,
  });

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${safePage - 1}`)
      .setLabel('Prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${safePage + 1}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );

  return { embeds: [embed], components: [row] };
}

/** Compact “added to queue” card (no transport buttons). */
export function buildQueuedTrackDisplay(
  track: Track,
  opts: { label: string; footer?: string },
): V2Display {
  const linkUrl = track.sourceUrl || track.url;
  const titleLine = linkUrl
    ? `### [${track.title.slice(0, 200)}](${linkUrl})`
    : `### ${track.title.slice(0, 200)}`;
  const artist = (track.uploader ?? '').slice(0, 80);

  const lines = [`**${opts.label}** · ${musicSourceLabel(track.source)}`, titleLine];
  if (artist) lines.push(`*${artist}*`);
  lines.push(`\`${formatDuration(track.durationSec)}\` · ${track.requestedBy}`);
  if (opts.footer) lines.push(`-# ${opts.footer}`);

  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );
  const thumb = thumbnailFor(track.thumbnail, track.title);
  if (thumb) section.setThumbnailAccessory(thumb);

  const container = new ContainerBuilder()
    .setAccentColor(musicAccent(track.source))
    .addSectionComponents(section);

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
