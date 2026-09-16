import { SlashCommandBuilder } from 'discord.js';
import { buildTrackEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const nowplaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services);
    if (!player || !player.current) return;

    await interaction.reply({
      embeds: [buildTrackEmbed(player.current, player.paused ? 'Paused' : 'Now Playing')],
    });
  },
};
