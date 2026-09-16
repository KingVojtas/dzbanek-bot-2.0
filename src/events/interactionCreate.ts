import {
  Events,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Collection,
  type InteractionReplyOptions,
} from 'discord.js';
import { QUEUE_BUTTON_PREFIX, queueButtons } from '../commands/music/queue';
import {
  QUEUE_PAGE_SIZE,
  buildInfoEmbed,
  buildQueueEmbed,
  queueTotalPages,
  upcomingQueue,
} from '../core/embeds';
import type { Command, Services } from '../core/types';
import type { GuildPlayer } from '../music/GuildPlayer';

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
  if (interaction.customId.startsWith('music:')) {
    await handleMusicButton(interaction, services);
    return;
  }

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

  const totalPages = queueTotalPages(
    upcomingQueue(player.current, player.queue).length,
    QUEUE_PAGE_SIZE,
  );
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  await interaction.update({
    embeds: [buildQueueEmbed(player.current, player.queue, safePage)],
    components: [queueButtons(safePage, totalPages)],
  });
}

async function handleMusicButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildInfoEmbed('This can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const player = services.music.get(guildId);
  if (!player || !player.current) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 Nothing is playing right now.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!inSameVoice(interaction, player)) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 Join the voice channel the bot is in to use these controls.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = interaction.customId;

  if (id === 'music:stop') {
    await interaction.deferUpdate();
    player.stop();
    return;
  }

  if (id === 'music:skip') {
    await interaction.deferUpdate();
    player.skip();
    return;
  }

  if (id === 'music:pause') {
    player.pause();
  } else if (id === 'music:resume') {
    player.resume();
  } else if (id === 'music:loop') {
    player.cycleLoopMode();
  } else if (id === 'music:shuffle') {
    const n = player.shuffle();
    if (n === 0) {
      await interaction.reply({
        embeds: [buildInfoEmbed('⚠️ Need at least 2 queued tracks to shuffle.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    await interaction.deferUpdate();
    return;
  }

  const display = player.buildNowPlayingPanel();
  await interaction.update({
    components: display.components,
    flags: display.flags,
  });
}

function inSameVoice(interaction: ButtonInteraction, player: GuildPlayer): boolean {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) return false;
  return member.voice.channelId === player.connection.joinConfig.channelId;
}
