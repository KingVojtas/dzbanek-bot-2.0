import {
  Events,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Collection,
  type InteractionReplyOptions,
} from 'discord.js';
import { QUEUE_BUTTON_PREFIX } from '../core/display/music';
import { WISHLIST_BUTTON_PREFIX } from '../core/display/wishlist';
import { buildReplyEmbed } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { QUIZ_BUTTON_PREFIX } from '../quiz/display';
import { CATCH_PLAY_PREFIX, RADIO_VOTE_PREFIX } from '../kitchen/display';
import { handleCatchPlay, handleRadioVoteButton } from './buttons/kitchen';
import { handleMusicButton } from './buttons/music';
import { handleQueuePage, handleWishlistPage } from './buttons/pages';
import { handleRadioButton } from './buttons/radio';

export function registerInteractionCreate(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      await command?.autocomplete?.(interaction, services).catch((error) => {
        services.logger.debug(`Autocomplete failed for /${interaction.commandName}:`, error);
      });
      return;
    }

    try {
      if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) {
          services.logger.warn(`Unknown command: /${interaction.commandName}`);
          return;
        }
        await command.execute(interaction, services);
        return;
      }

      if (interaction.isButton()) {
        await handleButton(interaction, services);
      }
    } catch (error) {
      services.logger.error('Interaction handler failed:', error);
      const payload: InteractionReplyOptions = {
        embeds: [buildReplyEmbed('error', '❌ Something went wrong while running that command.')],
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
    }
  });
}

async function handleButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId.startsWith('music:')) {
    await handleMusicButton(interaction, services);
    return;
  }

  if (interaction.customId.startsWith('radio:')) {
    await handleRadioButton(interaction, services);
    return;
  }

  if (interaction.customId.startsWith(RADIO_VOTE_PREFIX)) {
    await handleRadioVoteButton(interaction, services);
    return;
  }

  if (
    interaction.customId === CATCH_PLAY_PREFIX ||
    interaction.customId.startsWith(`${CATCH_PLAY_PREFIX}:`)
  ) {
    await handleCatchPlay(interaction, services);
    return;
  }

  if (interaction.customId.startsWith(QUIZ_BUTTON_PREFIX)) {
    await services.quiz.handleButton(interaction);
    return;
  }

  if (interaction.customId.startsWith(WISHLIST_BUTTON_PREFIX)) {
    await handleWishlistPage(interaction, services);
    return;
  }

  if (interaction.customId.startsWith(QUEUE_BUTTON_PREFIX)) {
    await handleQueuePage(interaction, services);
  }
}
