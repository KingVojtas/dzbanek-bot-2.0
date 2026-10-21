import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import { buildSiteEmbed, type EmbedCard } from '../core/embeds';
import type { NowPlayingTrack } from './now-playing';
import type { RadioStation } from './station';

export interface RadioPlayingOptions {
  track?: NowPlayingTrack | null;
}

/** "Artist — Song", or just the title when the station sends no artist. */
export function radioSongLine(track: NowPlayingTrack | null | undefined): string {
  const title = track?.title?.trim() ?? '';
  const artist = track?.artist?.trim() ?? '';
  if (!title) return 'Live stream';
  return artist && artist !== title ? `${artist} — ${title}` : title;
}

/** Live radio card, as on the website. The same message edits itself when the song changes. */
export function buildRadioPlayingDisplay(
  station: RadioStation,
  opts: RadioPlayingOptions = {},
): EmbedCard {
  const embed = buildSiteEmbed({
    color: station.color,
    author: `● Live · ${station.name}`,
    authorUrl: station.websiteUrl,
    title: radioSongLine(opts.track),
    description: `*${station.slogan}*`,
    footer: 'Edits itself when the song on air changes',
  });

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('radio:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Website').setURL(station.websiteUrl),
    new ButtonBuilder()
      .setCustomId('radio:catch')
      .setLabel('Catch')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}
