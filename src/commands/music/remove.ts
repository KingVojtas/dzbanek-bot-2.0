import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const remove: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the upcoming queue.')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('1-based position in the upcoming queue')
        .setMinValue(1)
        .setRequired(true),
    ),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const position = interaction.options.getInteger('position', true);
    const removed = player.remove(position - 1);
    if (!removed) {
      await interaction.reply({
        embeds: [buildInfoEmbed(`❌ No track at position **${position}**.`)],
      });
      return;
    }

    await interaction.reply({
      embeds: [buildInfoEmbed(`🗑️ Removed **${removed.title}** from the queue.`)],
    });
  },
};
