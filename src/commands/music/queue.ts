import { SlashCommandBuilder } from 'discord.js';
import { buildQueueDisplay } from '../../core/display/music';
import type { Command } from '../../core/types';
import { replyEphemeral } from './_util';

export const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue and now-playing track.')
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Queue page (1-based)')
        .setMinValue(1)
        .setRequired(false),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await replyEphemeral(interaction, 'This command can only be used in a server.');
      return;
    }

    const player = services.music.get(guildId);
    if (!player || (!player.current && player.queue.length === 0)) {
      await replyEphemeral(interaction, '🔇 The queue is empty.');
      return;
    }

    const requested = (interaction.options.getInteger('page') ?? 1) - 1;
    const display = buildQueueDisplay(player.current, player.queue, requested);

    await interaction.reply({ embeds: display.embeds, components: display.components });
  },
};
