import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} from 'discord.js';
import { QUEUE_PAGE_SIZE, buildQueueEmbed, queueTotalPages, upcomingQueue } from '../../core/embeds';
import type { Command } from '../../core/types';
import { replyEphemeral } from './_util';

export const QUEUE_BUTTON_PREFIX = 'queue:page:';

export function queueButtons(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${page - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${QUEUE_BUTTON_PREFIX}${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

export const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue and now-playing track.')
    .addIntegerOption((option) =>
      option.setName('page').setDescription('Queue page (1-based)').setMinValue(1).setRequired(false),
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

    const upcoming = upcomingQueue(player.current, player.queue);
    const totalPages = queueTotalPages(upcoming.length, QUEUE_PAGE_SIZE);
    const requested = (interaction.options.getInteger('page') ?? 1) - 1;
    const page = Math.min(Math.max(0, requested), totalPages - 1);

    await interaction.reply({
      embeds: [buildQueueEmbed(player.current, player.queue, page)],
      components: [queueButtons(page, totalPages)],
    });
  },
};
