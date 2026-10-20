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
import type { V2Display } from '../core/display';
import { STATION_LIST, type StationId } from '../radio/station';
import type { VoteCounts } from './votes';

export const KITCHEN_COLOR = 0xc4783a;
export const RADIO_NIGHT_CRON = '0 20 * * 5';
export const RADIO_NIGHT_LABEL = 'Friday 20:00';
export const RADIO_VOTE_PREFIX = 'kitchen:vote:';

const HERO_FILE = 'kitchen-hero.jpg';
const THUMB_FILE = 'kitchen-thumb.jpg';
const HERO_ATTACHMENT = `attachment://${HERO_FILE}`;
const THUMB_ATTACHMENT = `attachment://${THUMB_FILE}`;

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

export interface KitchenStereo {
  kind: 'radio' | 'music' | 'quiet';
  title: string;
  artist: string;
  sourceLabel: string;
  sourceUrl?: string;
  titleUrl?: string;
  heroUrl?: string;
  logoUrl?: string;
  color: number;
  websiteUrl?: string;
  paused?: boolean;
  queueLength?: number;
}

export interface KitchenListener {
  id: string;
  name: string;
}

export interface KitchenDealTeaser {
  title: string;
  kicker: string;
  line: string;
  url?: string;
  image?: string;
}

export interface KitchenBoardView {
  stereo: KitchenStereo;
  listeners: KitchenListener[];
  voiceChannelName?: string;
  steam?: KitchenDealTeaser;
  steamCount: number;
  epic?: KitchenDealTeaser;
  joinsToday: number;
  radioNight?: { stationName: string };
  radioVote?: { counts: VoteCounts; total: number };
  latestCatch?: {
    userId: string;
    title: string;
    artist: string;
    by: string;
    coverUrl?: string | null;
  };
}

export const CATCH_PLAY_PREFIX = 'kitchen:catch-play';

export interface KitchenDisplay extends V2Display {
  files?: AttachmentBuilder[];
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || value.startsWith('attachment://')) return value;
  return undefined;
}

function thumbnailFor(url: string | undefined, alt: string): ThumbnailBuilder | null {
  const href = httpUrl(url);
  if (!href) return null;
  return new ThumbnailBuilder().setURL(href).setDescription(alt.slice(0, 100));
}

const BOARD_LAYOUT = 'cards';

function titleLine(stereo: KitchenStereo): string {
  const title = stereo.title.slice(0, 200);
  if (stereo.titleUrl && /^https?:\/\//i.test(stereo.titleUrl)) {
    return `### [${title}](${stereo.titleUrl})`;
  }
  return `### ${title}`;
}

function presenceLine(view: KitchenBoardView): string {
  const stereo = view.stereo;
  const bits: string[] = [];
  if (stereo.kind === 'radio') {
    const site = stereo.sourceUrl && /^https?:\/\//i.test(stereo.sourceUrl) ? stereo.sourceUrl : '';
    bits.push(site ? `[${stereo.sourceLabel}](${site})` : stereo.sourceLabel);
  } else if (stereo.kind === 'music') {
    bits.push(stereo.sourceLabel);
    if (stereo.paused) bits.push('Paused');
    if (stereo.queueLength != null && stereo.queueLength > 0) {
      bits.push(`Queue **${stereo.queueLength}**`);
    }
  }
  if (view.voiceChannelName) {
    const n = view.listeners.length;
    const who = n === 1 ? '1 in the kitchen' : `${n} in the kitchen`;
    bits.push(`#${view.voiceChannelName}`, who);
  }
  return bits.join(' · ');
}

function nameLine(view: KitchenBoardView): string {
  if (view.listeners.length === 0) return '';
  const shown = view.listeners.slice(0, 8);
  const extra = view.listeners.length - shown.length;
  const more = extra > 0 ? ` · +${extra}` : '';
  return `-# ${shown.map((member) => member.name).join(' · ')}${more}`;
}

function stereoText(view: KitchenBoardView): string {
  const stereo = view.stereo;
  const lines: string[] = [];
  if (stereo.kind === 'quiet') {
    lines.push('### The Kitchen', '*Nothing on.*');
  } else {
    lines.push(titleLine(stereo));
    const artist = stereo.artist.trim();
    if (artist && artist !== stereo.title.trim()) lines.push(`*${artist.slice(0, 80)}*`);
  }
  const presence = presenceLine(view);
  if (presence) lines.push(presence);
  const names = nameLine(view);
  if (names) lines.push(names);
  if (stereo.kind === 'quiet') lines.push('-# /radio play · /play');
  if (!/the kitchen/i.test(lines.join('\n'))) lines.push('-# The Kitchen');
  return lines.join('\n');
}

function cookieLine(joins: number): string {
  if (joins === 1) return '🍪 **1** cookie out of the jar today';
  return `🍪 **${joins}** cookies out of the jar today`;
}

interface LinkButton {
  label: string;
  url: string;
}

/**
 * A section has to carry a thumbnail or a button. Text with neither stays a
 * plain text block so a missing image still posts.
 */
function addBlock(
  container: ContainerBuilder,
  text: string,
  thumbUrl: string | undefined,
  alt: string,
  link?: LinkButton,
): void {
  const content = text.slice(0, 4000);
  const thumb = thumbnailFor(thumbUrl, alt);
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(content),
  );
  if (thumb) {
    section.setThumbnailAccessory(thumb);
    container.addSectionComponents(section);
    return;
  }
  if (link) {
    section.setButtonAccessory(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(link.label).setURL(link.url),
    );
    container.addSectionComponents(section);
    return;
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

function dealText(teaser: KitchenDealTeaser): string {
  const title = teaser.title.slice(0, 120);
  const heading = teaser.url ? `### [${title}](${teaser.url})` : `### ${title}`;
  const lines = [`-# ${teaser.kicker}`, heading];
  if (teaser.line.trim()) lines.push(teaser.line.slice(0, 200));
  return lines.join('\n');
}

function openLink(url: string | undefined, label: string): LinkButton | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return { label, url };
}

function kitchenFiles(): AttachmentBuilder[] {
  const files: AttachmentBuilder[] = [];
  const hero = join(assetsDir, HERO_FILE);
  const thumb = join(assetsDir, THUMB_FILE);
  if (existsSync(hero)) files.push(new AttachmentBuilder(hero, { name: HERO_FILE }));
  if (existsSync(thumb)) files.push(new AttachmentBuilder(thumb, { name: THUMB_FILE }));
  return files;
}

interface StereoArt {
  hero?: string;
  thumb?: string;
  files?: AttachmentBuilder[];
  open?: LinkButton;
}

/**
 * Wide art is a real cover, or the kitchen photo when the stereo is off.
 * The station mark stays the thumbnail. The same file is not used as both.
 */
function stereoArt(stereo: KitchenStereo): StereoArt {
  if (stereo.kind === 'quiet') {
    const files = kitchenFiles();
    const names = new Set(files.map((file) => file.name));
    const hero = names.has(HERO_FILE) ? HERO_ATTACHMENT : undefined;
    const thumb = names.has(THUMB_FILE) ? THUMB_ATTACHMENT : undefined;
    const attached = files.length > 0 ? files : undefined;
    if (hero && thumb) return { hero, thumb, files: attached };
    if (thumb) return { thumb, files: attached };
    if (hero) return { thumb: hero, files: attached };
    return {};
  }

  const cover = httpUrl(stereo.heroUrl);
  const mark = httpUrl(stereo.logoUrl);
  if (stereo.kind === 'music') {
    const open = openLink(stereo.titleUrl, 'Open');
    if (cover && open) return { hero: cover, open };
    if (cover) return { thumb: cover };
    if (open) return { open };
    return {};
  }

  if (mark && cover && cover !== mark) return { hero: cover, thumb: mark };
  if (mark) return { thumb: mark };
  if (cover) return { thumb: cover };
  return {};
}

function stereoButtons(
  stereo: KitchenStereo,
): ActionRowBuilder<MessageActionRowComponentBuilder> | null {
  if (stereo.kind !== 'radio') return null;
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  const site = openLink(stereo.websiteUrl, 'Website');
  if (site) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(site.label).setURL(site.url),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId('radio:catch')
      .setLabel('Catch')
      .setEmoji('🍪')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('radio:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
  );
  return row;
}

function buildStereoCard(view: KitchenBoardView, art: StereoArt): ContainerBuilder {
  const stereo = view.stereo;
  const container = new ContainerBuilder().setAccentColor(
    stereo.kind === 'quiet' ? KITCHEN_COLOR : stereo.color,
  );
  if (art.hero) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(art.hero).setDescription(stereo.title.slice(0, 100)),
      ),
    );
  }
  addBlock(container, stereoText(view), art.thumb, stereo.sourceLabel || stereo.title, art.open);
  const buttons = stereoButtons(stereo);
  if (buttons) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addActionRowComponents(buttons);
  }
  return container;
}

function addDeal(
  container: ContainerBuilder,
  teaser: KitchenDealTeaser | undefined,
  empty: string,
): void {
  if (!teaser) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${empty}`));
    return;
  }
  const title = teaser.title.slice(0, 120);
  const link = teaser.image ? undefined : openLink(teaser.url, 'Open');
  addBlock(container, dealText(teaser), teaser.image, title, link);
}

function buildCounterCard(view: KitchenBoardView): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(KITCHEN_COLOR);
  const steamEmpty = 'Steam · the shelf is clear';
  const epicEmpty = 'Epic · nothing free this week';
  if (!view.steam && !view.epic) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${steamEmpty}\n-# ${epicEmpty}`),
    );
    return container;
  }
  addDeal(container, view.steam, steamEmpty);
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  addDeal(container, view.epic, epicEmpty);
  return container;
}

function catchText(caught: NonNullable<KitchenBoardView['latestCatch']>): string {
  const title = caught.title.slice(0, 80);
  const artist = caught.artist.slice(0, 60);
  return [`**${caught.by}** caught`, `### ${title}`, `*${artist}*`].join('\n');
}

function roomStatus(view: KitchenBoardView): string {
  const lines: string[] = [];
  if (view.joinsToday > 0) lines.push(cookieLine(view.joinsToday));
  if (view.radioVote) {
    lines.push('📻 **Radio Night vote** · closes 20:00');
  } else if (view.radioNight) {
    lines.push(`📻 **Radio Night** · ${RADIO_NIGHT_LABEL} · ${view.radioNight.stationName}`);
  }
  return lines.join('\n');
}

function roomHasNews(view: KitchenBoardView): boolean {
  return Boolean(view.latestCatch || view.radioVote || view.radioNight || view.joinsToday > 0);
}

function playRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CATCH_PLAY_PREFIX)
      .setLabel('Play')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary),
  );
}

/** Bottom card. Left out when nobody caught a song, voted, joined, or set Radio Night. */
function buildRoomCard(view: KitchenBoardView): ContainerBuilder | null {
  if (!roomHasNews(view)) return null;
  const container = new ContainerBuilder().setAccentColor(KITCHEN_COLOR);
  if (view.latestCatch) {
    addBlock(
      container,
      catchText(view.latestCatch),
      httpUrl(view.latestCatch.coverUrl ?? undefined),
      view.latestCatch.title,
    );
    container.addActionRowComponents(playRow());
  }
  const status = roomStatus(view);
  if (status) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(status.slice(0, 4000)));
  }
  if (view.radioVote) container.addActionRowComponents(voteButtons(view.radioVote.counts));
  return container;
}

/** Living hub: a stereo card, an amber counter, and a room card when there is news. */
export function buildKitchenBoardDisplay(view: KitchenBoardView): KitchenDisplay {
  const art = stereoArt(view.stereo);
  const components = [buildStereoCard(view, art), buildCounterCard(view)];
  const room = buildRoomCard(view);
  if (room) components.push(room);
  return {
    components,
    flags: MessageFlags.IsComponentsV2,
    files: art.files,
  };
}

export function kitchenViewKey(view: KitchenBoardView): string {
  return [
    BOARD_LAYOUT,
    view.stereo.kind,
    view.stereo.paused ? '1' : '0',
    String(view.stereo.queueLength ?? ''),
    view.stereo.title,
    view.stereo.artist,
    view.stereo.heroUrl ?? '',
    view.voiceChannelName ?? '',
    view.listeners.map((m) => m.id).join(','),
    view.steam?.title ?? '',
    view.steam?.line ?? '',
    view.epic?.title ?? '',
    view.epic?.line ?? '',
    String(view.joinsToday),
    view.radioNight?.stationName ?? '',
    view.latestCatch
      ? `${view.latestCatch.userId}:${view.latestCatch.title}:${view.latestCatch.artist}`
      : '',
    view.radioVote
      ? STATION_LIST.map((station) => `${station.id}:${view.radioVote!.counts[station.id]}`).join(
          ',',
        )
      : '',
  ].join('|');
}

function voteButtons(counts: VoteCounts): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const leader = STATION_LIST.reduce<StationId>(
    (best, station) => (counts[station.id] > counts[best] ? station.id : best),
    'beat',
  );
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  for (const station of STATION_LIST) {
    const n = counts[station.id];
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${RADIO_VOTE_PREFIX}${station.id}`)
        .setLabel(n > 0 ? `${station.choiceName} · ${n}` : station.choiceName)
        .setStyle(station.id === leader && n > 0 ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }
  return row;
}

export function looksLikeKitchenBoard(blob: string): boolean {
  if (!/the kitchen/i.test(blob)) return false;
  if (/\bsteam\b/i.test(blob) && /\bepic\b/i.test(blob)) return true;
  return (
    /live stereo|oven|quiet · the kitchen|on the stereo|jar’s full|cookies out of the jar/i.test(
      blob,
    ) || /● live|now playing/i.test(blob)
  );
}
