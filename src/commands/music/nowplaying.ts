import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildReplyEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { replyEphemeral, requirePlayer } from './_util';

export const nowPlaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Bring the Now Playing card down to the bottom of this chat.'),

  async execute(interaction, services) {
    const player = await requirePlayer(interaction, services);
    if (!player) return;

    const channel = interaction.channel?.isSendable() ? interaction.channel : null;
    if (!channel) {
      await replyEphemeral(interaction, '⚠️ I can’t post in this channel.');
      return;
    }

    // Ephemeral ack first: the card itself is the visible answer.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const posted = await player.repostNowPlaying(channel);
    await interaction.editReply({
      embeds: [
        posted
          ? buildReplyEmbed('success', '🎶 The Now Playing card is right below.')
          : buildReplyEmbed('error', '❌ Could not post the Now Playing card here.'),
      ],
    });
  },
};
