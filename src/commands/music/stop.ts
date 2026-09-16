import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    player.stop();
    await interaction.reply({
      embeds: [buildInfoEmbed('⏹️ Stopped playback, cleared the queue, and left the voice channel.')],
    });
  },
};
