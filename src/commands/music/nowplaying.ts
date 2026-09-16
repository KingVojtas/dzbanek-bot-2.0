import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const nowplaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services);
    if (!player || !player.current) return;

    const display = player.buildNowPlayingPanel();
    await interaction.reply({
      components: display.components,
      flags: display.flags,
    });
  },
};
