import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import { buildReplyEmbed } from '../../core/embeds';
import type { Services } from '../../core/types';
import { RadioCatchStore } from '../../kitchen/catches';
import { CATCH_PLAY_PREFIX } from '../../kitchen/display';
import { catchBlockReason } from '../../radio/now-playing';
import { plain, replyButton } from './reply';

const catches = new RadioCatchStore();

export async function handleRadioButton(
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

  if (interaction.customId === 'radio:catch') {
    await handleRadioCatch(interaction, services);
    return;
  }

  if (interaction.customId !== 'radio:stop') {
    await interaction.deferUpdate();
    return;
  }

  if (!services.radio.isPlaying(guildId)) {
    await interaction.reply({
      embeds: [buildReplyEmbed('warn', '🔇 Radio is not playing right now.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  const botChannelId = services.radio.channelId(guildId);
  if (
    !(member instanceof GuildMember) ||
    !botChannelId ||
    member.voice.channelId !== botChannelId
  ) {
    await interaction.reply({
      embeds: [
        buildReplyEmbed('warn', '🔇 Join the voice channel the bot is in to use this control.'),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  services.radio.stop(guildId);
  services.kitchen.refresh(guildId);
}

async function handleRadioCatch(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyButton(interaction, 'This can only be used in a server.');
    return;
  }

  const session = services.radio.get(guildId);
  if (!session || !services.radio.isPlaying(guildId)) {
    await replyButton(interaction, '🔇 Radio isn’t on.');
    return;
  }

  const track = session.nowPlaying;
  const reason = catchBlockReason(track, session.station);
  if (reason || !track?.artist) {
    await replyButton(interaction, reason ?? 'That’s the show, not a song.');
    return;
  }

  await interaction.deferReply();
  const saved = await catches.save({
    guildId,
    userId: interaction.user.id,
    stationId: session.station.id,
    artist: track.artist,
    title: track.title,
    coverUrl: track.coverUrl,
  });
  const who =
    interaction.member instanceof GuildMember
      ? interaction.member.displayName
      : interaction.user.username;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CATCH_PLAY_PREFIX}:${saved.id}`)
      .setLabel('Play')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary),
  );
  await interaction.editReply({
    content: `🍪 **${plain(who, 32)}** caught **${plain(track.title, 80)}** — ${plain(track.artist, 80)}`,
    components: [row],
  });
  services.kitchen.refresh(guildId);
}
