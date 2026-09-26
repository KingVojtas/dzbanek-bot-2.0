import {
  ActionRowBuilder,
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
import type { NowPlayingTrack } from './now-playing';
import type { RadioStation } from './station';

export interface RadioPlayingOptions {
  alreadyPlaying?: boolean;
  track?: NowPlayingTrack | null;
}

export function buildRadioPlayingDisplay(
  station: RadioStation,
  channelName: string,
  opts: RadioPlayingOptions = {},
): V2Display {
  const track = opts.track ?? null;
  const liveLabel = opts.alreadyPlaying ? 'ON AIR' : 'LIVE';
  const songTitle = track?.title.slice(0, 200) || 'Live stream';
  const artist = (track?.artist ?? station.slogan).slice(0, 80);
  const heroUrl = httpUrl(track?.coverUrl) ?? station.imageUrl;

  const body = [
    `**● ${liveLabel}** · [${station.name}](${station.websiteUrl})`,
    `### ${songTitle}`,
    `*${artist}*`,
    '',
    `🔊 Playing in **#${channelName}**`,
    `-# ${station.slogan} · Icecast 128 kbps`,
  ];

  const text = new TextDisplayBuilder().setContent(body.join('\n').slice(0, 4000));
  const logoUrl = httpUrl(station.logoUrl);
  const distinctLogo = logoUrl && logoUrl !== heroUrl ? logoUrl : undefined;

  const container = new ContainerBuilder().setAccentColor(station.color);

  if (heroUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(heroUrl).setDescription(songTitle.slice(0, 100)),
      ),
    );
  }

  // A Section accessory is required. Rock Radio uses one image for hero and logo,
  // so the text sits on its own instead of a section with no thumbnail.
  if (distinctLogo) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text)
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(distinctLogo).setDescription(station.name.slice(0, 100)),
        ),
    );
  } else {
    container.addTextDisplayComponents(text);
  }

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Website').setURL(station.websiteUrl),
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

  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addActionRowComponents(row);

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  return value;
}
