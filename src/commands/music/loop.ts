import { SlashCommandBuilder } from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command, LoopMode } from '../../core/types';
import { requirePlayer } from './_util';

export const loop: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode.')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Loop mode')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        ),
    ),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const mode = interaction.options.getString('mode', true) as LoopMode;
    player.setLoopMode(mode);

    const label = mode === 'off' ? 'off' : mode === 'track' ? 'current track' : 'entire queue';
    await interaction.reply({ embeds: [buildInfoEmbed(`🔁 Loop is now **${label}**.`)] });
  },
};
