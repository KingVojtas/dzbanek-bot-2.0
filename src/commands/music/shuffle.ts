import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const n = player.shuffle();
    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          n > 0
            ? `🔀 Shuffled **${n}** upcoming track${n === 1 ? '' : 's'}.`
            : '⚠️ Need at least 2 queued tracks to shuffle.',
        ),
      ],
    });
  },
};
