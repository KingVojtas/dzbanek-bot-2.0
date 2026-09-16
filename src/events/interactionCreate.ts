import {
  Events,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Collection,
  type InteractionReplyOptions,
} from 'discord.js';
import { QUEUE_BUTTON_PREFIX, queueButtons } from '../commands/music/queue';
import { QUEUE_PAGE_SIZE, buildQueueEmbed, queueTotalPages } from '../core/embeds';
import type { Command, Services } from '../core/types';

export function registerInteractionCreate(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
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
        content: 'Something went wrong while running that command.',
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
  if (!interaction.customId.startsWith(QUEUE_BUTTON_PREFIX)) return;

  const page = Number.parseInt(interaction.customId.slice(QUEUE_BUTTON_PREFIX.length), 10);
  if (!Number.isFinite(page) || !interaction.guildId) {
    await interaction.deferUpdate();
    return;
  }

  const player = services.music.get(interaction.guildId);
  if (!player) {
    await interaction.update({
      content: 'The queue is no longer active.',
      embeds: [],
      components: [],
    });
    return;
  }

  const totalPages = queueTotalPages(player.queue.length, QUEUE_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  await interaction.update({
    embeds: [buildQueueEmbed(player.current, player.queue, safePage)],
    components: [queueButtons(safePage, totalPages)],
  });
}
