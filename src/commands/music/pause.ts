import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const pause: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    if (player.paused) {
      await interaction.reply({ embeds: [buildInfoEmbed('⏸️ Playback is already paused.')] });
      return;
    }

    const ok = player.pause();
    await interaction.reply({
      embeds: [buildInfoEmbed(ok ? '⏸️ Paused.' : '❌ Could not pause playback.')],
    });
  },
};
