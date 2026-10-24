import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { buildQueueDisplay } from '../../core/display/music';
import { buildReplyEmbed } from '../../core/embeds';
import type { Services } from '../../core/types';
import { KITCHEN_BUTTON_SUFFIX } from '../../kitchen/display';
import { inSameVoice, updateCard } from './reply';

export async function handleMusicButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildReplyEmbed('warn', 'This can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const player = services.music.get(guildId);
  if (!player || !player.current) {
    await interaction.reply({
      embeds: [buildReplyEmbed('warn', '🔇 Nothing is playing right now.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The Kitchen Board's controls carry a suffix: they act, then the board redraws.
  const onBoard = interaction.customId.endsWith(KITCHEN_BUTTON_SUFFIX);
  const id = onBoard
    ? interaction.customId.slice(0, -KITCHEN_BUTTON_SUFFIX.length)
    : interaction.customId;

  // Looking at the queue changes nothing, so anyone may open it.
  if (id === 'music:queue') {
    const display = buildQueueDisplay(player.current, player.queue, 0);
    await interaction.reply({
      embeds: display.embeds,
      components: display.components,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!inSameVoice(interaction, player)) {
    await interaction.reply({
      embeds: [
        buildReplyEmbed('warn', '🔇 Join the voice channel the bot is in to use these controls.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (id === 'music:stop') {
    await interaction.deferUpdate();
    player.stop();
    services.kitchen.refresh(guildId);
    return;
  }

  if (id === 'music:skip') {
    await interaction.deferUpdate();
    player.skip();
    services.kitchen.refresh(guildId);
    return;
  }

  if (id === 'music:prev') {
    if (!player.previous()) {
      await interaction.reply({
        embeds: [buildReplyEmbed('warn', '⏮️ Nothing to go back to yet.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferUpdate();
    return;
  }

  if (id === 'music:pause') {
    player.pause();
  } else if (id === 'music:voldown' || id === 'music:volup') {
    player.stepVolume(id === 'music:volup' ? 1 : -1);
  } else if (id === 'music:resume') {
    player.resume();
  } else if (id === 'music:loop') {
    player.cycleLoopMode();
  } else if (id === 'music:shuffle') {
    const n = player.shuffle();
    if (n === 0) {
      await interaction.reply({
        embeds: [buildReplyEmbed('warn', '⚠️ Need at least 2 queued tracks to shuffle.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    await interaction.deferUpdate();
    return;
  }

  if (onBoard) {
    await interaction.deferUpdate();
    services.kitchen.refresh(guildId);
    return;
  }
  await updateCard(interaction, player.buildNowPlayingPanel());
  services.kitchen.refresh(guildId);
}
