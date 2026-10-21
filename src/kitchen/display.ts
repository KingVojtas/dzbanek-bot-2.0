import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type EmbedBuilder,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { linkText } from '../core/display';
import { SITE_GLOW, buildSiteEmbed, type EmbedCard, type SiteField } from '../core/embeds';
import { STATION_LIST, type StationId } from '../radio/station';
import type { VoteCounts } from './votes';

export const KITCHEN_COLOR = 0xc4783a;
export const RADIO_NIGHT_CRON = '0 20 * * 5';
export const RADIO_NIGHT_LABEL = 'Friday 20:00';
export const RADIO_VOTE_PREFIX = 'kitchen:vote:';

const THUMB_FILE = 'kitchen-thumb.jpg';
const THUMB_ATTACHMENT = `attachment://${THUMB_FILE}`;

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

export interface KitchenStereo {
  kind: 'radio' | 'music' | 'quiet';
  title: string;
  artist: string;
  sourceLabel: string;
  titleUrl?: string;
  color: number;
  websiteUrl?: string;
  paused?: boolean;
}

export interface KitchenListener {
  id: string;
  name: string;
}

export interface KitchenDealTeaser {
  title: string;
  line: string;
  url?: string;
}

export interface KitchenBoardView {
  stereo: KitchenStereo;
  listeners: KitchenListener[];
  voiceChannelName?: string;
  steam?: KitchenDealTeaser;
  epic?: KitchenDealTeaser;
  joinsToday: number;
  radioNight?: { stationName: string };
  radioVote?: { counts: VoteCounts; total: number };
  latestCatch?: {
    userId: string;
    title: string;
    artist: string;
    by: string;
  };
}

export const CATCH_PLAY_PREFIX = 'kitchen:catch-play';

const BOARD_LAYOUT = 'site';

/** Kiss, Rock, Beat: the names on the website's vote card. */
const VOTE_LABELS: Record<StationId, string> = { kiss: 'Kiss', rock: 'Rock', beat: 'Beat' };

function boardAuthor(stereo: KitchenStereo): string {
  if (stereo.kind === 'radio') return `● Live · ${stereo.sourceLabel}`;
  if (stereo.kind === 'music') {
    return `${stereo.paused ? '⏸️ Paused' : '🔊 Now Playing'} · ${stereo.sourceLabel}`;
  }
  return 'The Kitchen';
}

function boardTitle(stereo: KitchenStereo): string {
  if (stereo.kind === 'quiet') return 'Nothing on';
  const title = stereo.title.trim();
  const artist = stereo.artist.trim();
  if (stereo.kind === 'radio' && artist && artist !== title) return `${artist} — ${title}`;
  return title;
}

function dealValue(teaser: KitchenDealTeaser | undefined, empty: string): string {
  if (!teaser) return empty;
  const title = linkText(teaser.title, 80);
  const name = teaser.url && /^https?:\/\//i.test(teaser.url) ? `[${title}](${teaser.url})` : title;
  return teaser.line.trim() ? `${name} · ${teaser.line.trim()}` : name;
}

function nightValue(view: KitchenBoardView): string | null {
  if (view.radioVote) return `${RADIO_NIGHT_LABEL} · the vote is open below`;
  if (view.radioNight) return `${RADIO_NIGHT_LABEL} · ${view.radioNight.stationName}`;
  return null;
}

function boardFields(view: KitchenBoardView): SiteField[] {
  const fields: SiteField[] = [
    ['In voice', String(view.voiceChannelName ? view.listeners.length : 0)],
    ['Joined today', String(view.joinsToday)],
    ['Steam', dealValue(view.steam, 'The shelf is clear')],
    ['Epic', dealValue(view.epic, 'Nothing free this week')],
  ];
  const night = nightValue(view);
  if (night) fields.push(['Radio Night', night, true]);
  if (view.latestCatch) {
    const { by, title, artist } = view.latestCatch;
    const song = artist && artist !== title ? `${artist} — ${title}` : title;
    fields.push(['Latest catch', `**${by.slice(0, 40)}** caught ${song.slice(0, 160)}`, true]);
  }
  return fields;
}

function kitchenThumb(): AttachmentBuilder | null {
  const path = join(assetsDir, THUMB_FILE);
  return existsSync(path) ? new AttachmentBuilder(path, { name: THUMB_FILE }) : null;
}

function boardButtons(
  view: KitchenBoardView,
): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  const stereo = view.stereo;
  if (stereo.kind === 'radio') {
    row.addComponents(
      new ButtonBuilder().setCustomId('radio:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    );
    if (stereo.websiteUrl && /^https?:\/\//i.test(stereo.websiteUrl)) {
      row.addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Website')
          .setURL(stereo.websiteUrl),
      );
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('radio:catch')
        .setLabel('Catch')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (view.latestCatch) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(CATCH_PLAY_PREFIX)
        .setLabel('Play')
        .setStyle(ButtonStyle.Primary),
    );
  }
  return row.components.length > 0 ? row : null;
}

function tallyBar(n: number, total: number): string {
  const width = 10;
  const filled = total > 0 ? Math.round((n / total) * width) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** Friday's vote card, as on the website's Radio page. */
function buildVoteEmbed(counts: VoteCounts, total: number): EmbedBuilder {
  const lines = STATION_LIST.map((station) => {
    const n = counts[station.id];
    return `\`${VOTE_LABELS[station.id].padEnd(4)} ${tallyBar(n, total)}\` **${n}**`;
  });
  return buildSiteEmbed({
    color: SITE_GLOW,
    author: '🌙 Kitchen Board · Radio Night',
    title: 'Tonight at 20:00. Pick the station.',
    description: lines.join('\n'),
    footer: 'One vote each. You can change it.',
  });
}

function voteButtons(counts: VoteCounts): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const leader = STATION_LIST.reduce<StationId>(
    (best, station) => (counts[station.id] > counts[best] ? station.id : best),
    'beat',
  );
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  for (const station of STATION_LIST) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${RADIO_VOTE_PREFIX}${station.id}`)
        .setLabel(VOTE_LABELS[station.id])
        .setStyle(
          station.id === leader && counts[station.id] > 0
            ? ButtonStyle.Success
            : ButtonStyle.Secondary,
        ),
    );
  }
  return row;
}

/**
 * The website's Kitchen Board: what is on the stereo, who is in voice, the top
 * deals, and Radio Night. Friday's vote hangs underneath while it is open.
 */
export function buildKitchenBoardDisplay(view: KitchenBoardView): EmbedCard {
  const thumb = kitchenThumb();
  const board = buildSiteEmbed({
    color: view.stereo.kind === 'quiet' ? KITCHEN_COLOR : view.stereo.color,
    author: boardAuthor(view.stereo),
    authorUrl: view.stereo.kind === 'radio' ? view.stereo.websiteUrl : undefined,
    title: boardTitle(view.stereo),
    url: view.stereo.titleUrl,
    fields: boardFields(view),
    thumbnail: thumb ? THUMB_ATTACHMENT : undefined,
  });

  const embeds = [board];
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  const buttons = boardButtons(view);
  if (buttons) components.push(buttons);
  if (view.radioVote) {
    embeds.push(buildVoteEmbed(view.radioVote.counts, view.radioVote.total));
    components.push(voteButtons(view.radioVote.counts));
  }

  return { embeds, components, files: thumb ? [thumb] : [] };
}

export function kitchenViewKey(view: KitchenBoardView): string {
  return [
    BOARD_LAYOUT,
    view.stereo.kind,
    view.stereo.paused ? '1' : '0',
    view.stereo.title,
    view.stereo.artist,
    view.stereo.sourceLabel,
    view.stereo.titleUrl ?? '',
    view.voiceChannelName ?? '',
    String(view.listeners.length),
    teaserKey(view.steam),
    teaserKey(view.epic),
    String(view.joinsToday),
    view.radioNight?.stationName ?? '',
    view.latestCatch
      ? [
          view.latestCatch.userId,
          view.latestCatch.by,
          view.latestCatch.title,
          view.latestCatch.artist,
        ].join(':')
      : '',
    view.radioVote
      ? STATION_LIST.map((station) => `${station.id}:${view.radioVote!.counts[station.id]}`).join(
          ',',
        )
      : '',
  ].join('|');
}

function teaserKey(teaser: KitchenDealTeaser | undefined): string {
  if (!teaser) return '';
  return [teaser.title, teaser.line, teaser.url ?? ''].join(':');
}

/** The current board, or one from before the website layout, which gets replaced. */
export function looksLikeKitchenBoard(blob: string): boolean {
  if (/\bin voice\b/i.test(blob) && /\bjoined today\b/i.test(blob)) return true;
  if (!/the kitchen/i.test(blob)) return false;
  if (/\bsteam\b/i.test(blob) && /\bepic\b/i.test(blob)) return true;
  return (
    /live stereo|oven|quiet · the kitchen|on the stereo|jar’s full|cookies out of the jar/i.test(
      blob,
    ) || /● live|now playing/i.test(blob)
  );
}
