import { SlashCommandBuilder } from 'discord.js';
import { buildReplyEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip to the next track.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const skipped = player.current;
    const next = player.skip();
    const line = next
      ? `⏭️ Skipped **${skipped?.title ?? 'the track'}** · up next **${next.title}**.`
      : `⏭️ Skipped **${skipped?.title ?? 'the track'}**. The queue is empty now.`;
    await interaction.reply({ embeds: [buildReplyEmbed('success', line.slice(0, 4000))] });
  },
};
