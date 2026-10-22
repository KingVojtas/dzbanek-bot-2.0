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
  /** The voice channel it plays in. */
  channelId?: string | null;
  /** Epoch ms when the song on air changed. Shown after the footer. */
  since?: number;
}

function plain(value: string, limit: number): string {
  return value
    .replace(/[*_`~|>#[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Live radio card, as on the website. The same message edits itself when the song changes. */
export function buildRadioPlayingDisplay(
  station: RadioStation,
  opts: RadioPlayingOptions = {},
): EmbedCard {
  const title = opts.track?.title?.trim() ?? '';
  const artist = opts.track?.artist?.trim() ?? '';
  const description = [
    artist && artist !== title ? `by **${plain(artist, 120)}**` : '',
    `*${station.slogan}*`,
    opts.channelId ? `🎧 in <#${opts.channelId}>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const embed = buildSiteEmbed({
    color: station.color,
    author: `🔴 LIVE · ${station.name}`,
    authorUrl: station.websiteUrl,
    authorIcon: station.logoUrl,
    title: title || 'Live stream',
    url: station.websiteUrl,
    description,
    footer: title ? 'On air since' : 'Edits itself when the song on air changes',
    thumbnail: opts.track?.coverUrl ?? station.logoUrl,
    timestamp: title ? (opts.since ?? Date.now()) : undefined,
  });

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('radio:catch')
      .setLabel('Catch')
      .setEmoji('🍪')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!title),
    new ButtonBuilder()
      .setCustomId('radio:stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Website')
      .setEmoji('🌐')
      .setURL(station.websiteUrl),
  );

  return { embeds: [embed], components: [row] };
}
