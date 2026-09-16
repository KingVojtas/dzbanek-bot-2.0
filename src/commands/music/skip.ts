import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const skipped = player.current;
    const next = player.skip();
    const description = next
      ? `⏭️ Skipped **${skipped?.title ?? 'the current track'}**. Up next: **${next.title}**.`
      : `⏭️ Skipped **${skipped?.title ?? 'the current track'}**. Queue is empty.`;

    await interaction.reply({ embeds: [buildInfoEmbed(description)] });
  },
};
