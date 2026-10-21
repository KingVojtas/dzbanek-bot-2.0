import { SlashCommandBuilder } from 'discord.js';
import { buildReplyEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { requirePlayer } from './_util';

export const pause: Command = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the music, or resume it if it is already paused.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services, { sameVoice: true });
    if (!player) return;

    const resuming = player.paused;
    const ok = resuming ? player.resume() : player.pause();
    if (!ok) {
      await interaction.reply({
        embeds: [buildReplyEmbed('warn', '⚠️ The track is still loading. Try again in a moment.')],
      });
      return;
    }

    await interaction.reply({
      embeds: [buildReplyEmbed('success', resuming ? '▶️ Resumed.' : '⏸️ Paused.')],
    });
    if (interaction.guildId) services.kitchen.refresh(interaction.guildId);
    // After the reply: a rate-limited card edit must not expire the interaction.
    await player.refreshNowPlaying();
  },
};
