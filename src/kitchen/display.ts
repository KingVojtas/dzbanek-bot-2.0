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
  SeparatorSpacingSize,
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
  detail?: string;
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
  latestCatch?: { userId: string; title: string; artist: string; by: string };
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

function largeSep(): SeparatorBuilder {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large);
}

function heading(stereo: KitchenStereo): string {
  if (stereo.kind === 'radio') {
    const name = stereo.sourceUrl
      ? `[${stereo.sourceLabel}](${stereo.sourceUrl})`
      : stereo.sourceLabel;
    return `**● LIVE** · ${name}`;
  }
  if (stereo.kind === 'music') {
    const state = stereo.paused ? 'Paused' : 'Now Playing';
    return `**${state}** · ${stereo.sourceLabel}`;
  }
  return '**Quiet** · The Kitchen';
}

function titleLine(stereo: KitchenStereo): string {
  const title = stereo.title.slice(0, 200);
  if (stereo.titleUrl && /^https?:\/\//i.test(stereo.titleUrl)) {
    return `### [${title}](${stereo.titleUrl})`;
  }
  return `### ${title}`;
}

function listenerBlock(view: KitchenBoardView): string {
  const n = view.listeners.length;
  if (!view.voiceChannelName) {
    return '-# Oven’s cold. `/radio play` or `/play` to put the kettle on.';
  }
  if (n === 0) {
    return `🔊 **#${view.voiceChannelName}** is empty — hop in.`;
  }
  const shown = view.listeners.slice(0, 8);
  const names = shown.map((m) => m.name).join(' · ');
  const extra = n - shown.length;
  const more = extra > 0 ? ` · +${extra}` : '';
  const who = n === 1 ? '1 in the kitchen' : `${n} in the kitchen`;
  return `🔊 **#${view.voiceChannelName}** · ${who}\n${names}${more}`;
}

function cookieLine(joins: number): string {
  if (joins <= 0) return '🍪 Jar’s full · no new crumbs today';
  if (joins === 1) return '🍪 **1** cookie out of the jar today';
  return `🍪 **${joins}** cookies out of the jar today`;
}

function dealSection(
  teaser: KitchenDealTeaser | undefined,
  emptyKicker: string,
  empty: string,
): SectionBuilder {
  if (!teaser) {
    return new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${emptyKicker}\n*Nothing on the counter yet.*\n-# ${empty}`.slice(0, 4000),
      ),
    );
  }

  const title = teaser.title.slice(0, 120);
  const headingLine = teaser.url ? `### [${title}](${teaser.url})` : `### ${title}`;
  const lines = [`-# ${teaser.kicker}`, headingLine, teaser.line.slice(0, 200)];
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)),
  );
  const thumb = thumbnailFor(teaser.image, title);
  if (thumb) section.setThumbnailAccessory(thumb);
  return section;
}

function kitchenFiles(): AttachmentBuilder[] {
  const files: AttachmentBuilder[] = [];
  const hero = join(assetsDir, HERO_FILE);
  const thumb = join(assetsDir, THUMB_FILE);
  if (existsSync(hero)) files.push(new AttachmentBuilder(hero, { name: HERO_FILE }));
  if (existsSync(thumb)) files.push(new AttachmentBuilder(thumb, { name: THUMB_FILE }));
  return files;
}

function resolveQuietArt(stereo: KitchenStereo): {
  hero?: string;
  logo?: string;
  files?: AttachmentBuilder[];
} {
  if (stereo.kind !== 'quiet') {
    return { hero: httpUrl(stereo.heroUrl), logo: httpUrl(stereo.logoUrl) };
  }
  const files = kitchenFiles();
  const names = new Set(files.map((f) => f.name));
  return {
    hero: names.has(HERO_FILE) ? HERO_ATTACHMENT : httpUrl(stereo.heroUrl),
    logo: names.has(THUMB_FILE) ? THUMB_ATTACHMENT : httpUrl(stereo.logoUrl),
    files: files.length > 0 ? files : undefined,
  };
}

/** Living hub card: hero artwork, stereo, who’s around, today’s steal, Epic free. */
export function buildKitchenBoardDisplay(view: KitchenBoardView): KitchenDisplay {
  const stereo = view.stereo;
  const art = resolveQuietArt(stereo);
  const accent = stereo.kind === 'quiet' ? KITCHEN_COLOR : stereo.color;

  const stereoLines = [heading(stereo), titleLine(stereo), `*${stereo.artist.slice(0, 80)}*`];
  if (stereo.detail) stereoLines.push(stereo.detail);
  stereoLines.push('');
  stereoLines.push(listenerBlock(view));

  const stereoSection = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(stereoLines.join('\n').slice(0, 4000)),
  );
  const logo = art.logo && art.logo !== art.hero ? art.logo : undefined;
  const stereoThumb = thumbnailFor(logo, stereo.sourceLabel || stereo.title);
  if (stereoThumb) stereoSection.setThumbnailAccessory(stereoThumb);

  const footer = [cookieLine(view.joinsToday)];
  if (view.radioVote) {
    const bits = STATION_LIST.map(
      (station) => `${station.choiceName} **${view.radioVote!.counts[station.id]}**`,
    );
    footer.push(`📻 **Radio Night vote** · ${bits.join(' · ')} · closes 20:00`);
  } else if (view.radioNight) {
    footer.push(`📻 **Radio Night** · ${RADIO_NIGHT_LABEL} · ${view.radioNight.stationName}`);
  }
  if (view.latestCatch) {
    const title = view.latestCatch.title.slice(0, 80);
    const artist = view.latestCatch.artist.slice(0, 60);
    footer.push(`🍪 **${view.latestCatch.by}** caught **${title}** — ${artist}`);
  }
  footer.push('-# The Kitchen · `/radio play` · `/play`');

  const container = new ContainerBuilder().setAccentColor(accent);

  if (art.hero) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(art.hero).setDescription(stereo.title.slice(0, 100)),
      ),
    );
  }

  container.addSectionComponents(stereoSection).addSeparatorComponents(largeSep());

  const steamEmpty =
    view.steamCount > 0 ? `${view.steamCount} on the board` : 'Waiting for the next Steam poll.';
  container.addSectionComponents(
    dealSection(view.steam, 'STEAM', steamEmpty),
    dealSection(view.epic, 'EPIC', 'Waiting for the next Epic lineup.'),
  );

  container
    .addSeparatorComponents(largeSep())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(footer.join('\n').slice(0, 4000)),
    );

  if (view.radioVote) {
    container.addActionRowComponents(voteButtons(view.radioVote.counts));
  }

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  if (stereo.kind === 'radio' && stereo.websiteUrl && /^https?:\/\//i.test(stereo.websiteUrl)) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Website').setURL(stereo.websiteUrl),
    );
  }
  if (stereo.kind === 'music' && stereo.titleUrl && /^https?:\/\//i.test(stereo.titleUrl)) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open').setURL(stereo.titleUrl),
    );
  }
  if (stereo.kind === 'radio') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('radio:catch')
        .setLabel('Catch')
        .setEmoji('🍪')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (view.latestCatch) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(CATCH_PLAY_PREFIX)
        .setLabel('Play')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (stereo.kind === 'radio') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('radio:stop')
        .setLabel('Stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
    );
  }
  if (row.components.length > 0) {
    container.addActionRowComponents(row);
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    files: art.files,
  };
}

export function kitchenViewKey(view: KitchenBoardView): string {
  return [
    view.stereo.kind,
    view.stereo.title,
    view.stereo.artist,
    view.stereo.heroUrl ?? '',
    view.voiceChannelName ?? '',
    view.listeners.map((m) => m.id).join(','),
    view.steam?.title ?? '',
    view.epic?.title ?? '',
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
  return (
    /the kitchen/i.test(blob) &&
    (/live stereo|oven|quiet · the kitchen|on the stereo|jar’s full|cookies out of the jar/i.test(
      blob,
    ) ||
      /● live|now playing/i.test(blob))
  );
}
