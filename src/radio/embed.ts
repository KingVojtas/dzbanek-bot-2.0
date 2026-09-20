import { EmbedBuilder } from 'discord.js';
import type { RadioStation } from './station';

export function buildRadioPlayingEmbed(
  station: RadioStation,
  channelName: string,
  alreadyPlaying = false,
): EmbedBuilder {
  const status = alreadyPlaying ? 'Already on air' : 'Now playing';
  return new EmbedBuilder()
    .setColor(station.color)
    .setAuthor({
      name: 'LIVE RADIO',
      iconURL: station.logoUrl,
      url: station.websiteUrl,
    })
    .setTitle(station.name)
    .setURL(station.websiteUrl)
    .setDescription(`*${station.slogan}*\n\n${status} in **#${channelName}**`)
    .setThumbnail(station.logoUrl)
    .setImage(station.imageUrl)
    .addFields(
      { name: 'Station', value: station.name, inline: true },
      { name: 'Status', value: '● Live', inline: true },
      { name: 'Channel', value: `#${channelName}`, inline: true },
    )
    .setFooter({ text: 'Use /radio stop to disconnect' })
    .setTimestamp();
}
