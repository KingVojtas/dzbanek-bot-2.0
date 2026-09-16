import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const resume: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume paused playback.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    if (!player.paused) {
      await interaction.reply({ embeds: [buildInfoEmbed('▶️ Playback is not paused.')] });
      return;
    }

    const ok = player.resume();
    await interaction.reply({
      embeds: [buildInfoEmbed(ok ? '▶️ Resumed.' : '❌ Could not resume playback.')],
    });
  },
};
