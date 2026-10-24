import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { QUEUE_BUTTON_PREFIX, buildQueueDisplay } from '../../core/display/music';
import { WISHLIST_BUTTON_PREFIX } from '../../core/display/wishlist';
import { buildReplyEmbed } from '../../core/embeds';
import type { Services } from '../../core/types';
import { wishlistCard } from '../../commands/steam';
import { updateCard } from './reply';

/** Flip the queue card. */
export async function handleQueuePage(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const page = Number.parseInt(interaction.customId.slice(QUEUE_BUTTON_PREFIX.length), 10);
  if (!Number.isFinite(page) || !interaction.guildId) {
    await interaction.deferUpdate();
    return;
  }

  const player = services.music.get(interaction.guildId);
  if (!player) {
    await updateCard(interaction, {
      embeds: [buildReplyEmbed('info', 'The queue is no longer active.')],
      components: [],
    });
    return;
  }

  await updateCard(interaction, buildQueueDisplay(player.current, player.queue, page));
}

/** Flip the private wishlist card. Only its owner ever sees it, so the clicker is the owner. */
export async function handleWishlistPage(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const page = Number.parseInt(interaction.customId.slice(WISHLIST_BUTTON_PREFIX.length), 10);
  // A cold cache reads the whole wishlist again, which can outlast Discord's 3 s.
  await interaction.deferUpdate();
  const card = await wishlistCard(interaction.user.id, services, Number.isFinite(page) ? page : 0);
  if ('text' in card) {
    await interaction.followUp({
      embeds: [buildReplyEmbed(card.tone, card.text)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.editReply({ components: card.components });
}
