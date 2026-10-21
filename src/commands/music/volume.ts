import { SlashCommandBuilder } from 'discord.js';
import { buildReplyEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the music volume for everyone in the channel.')
    .addIntegerOption((option) =>
      option
        .setName('percent')
        .setDescription('25 to 150 (100 is normal)')
        .setMinValue(25)
        .setMaxValue(150)
        .setRequired(true),
    ),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const percent = interaction.options.getInteger('percent', true);
    const applied = Math.round(player.setVolume(percent / 100) * 100);
    await interaction.reply({
      embeds: [
        buildReplyEmbed('success', `${applied < 100 ? '🔉' : '🔊'} Volume set to **${applied}%**.`),
      ],
    });
    // After the reply: a rate-limited card edit must not expire the interaction.
    await player.refreshNowPlaying();
  },
};
