import { GuildMember, MessageFlags, type ButtonInteraction } from 'discord.js';
import { buildReplyEmbed } from '../../core/embeds';
import type { Services } from '../../core/types';
import { RadioCatchStore } from '../../kitchen/catches';
import { CATCH_PLAY_PREFIX, RADIO_VOTE_PREFIX } from '../../kitchen/display';
import { isStationId } from '../../kitchen/vote-tally';
import { playSearch } from '../../music/play-search';
import { plain, replyButton } from './reply';

const catches = new RadioCatchStore();

export async function handleRadioVoteButton(
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

  const stationId = interaction.customId.slice(RADIO_VOTE_PREFIX.length);
  if (!isStationId(stationId)) {
    await interaction.deferUpdate();
    return;
  }

  // Acknowledge before the database work so a slow write cannot expire the click.
  await interaction.deferUpdate();
  const result = await services.kitchen.castVote(guildId, interaction.user.id, stationId);
  if (!result.ok) await replyButton(interaction, result.reason);
}

export async function handleCatchPlay(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyButton(interaction, 'This can only be used in a server.');
    return;
  }

  const raw = interaction.customId.slice(CATCH_PLAY_PREFIX.length);
  let saved;
  if (raw.startsWith(':')) {
    const id = Number.parseInt(raw.slice(1), 10);
    if (!Number.isFinite(id)) {
      await replyButton(interaction, 'That catch is gone.');
      return;
    }
    saved = await catches.get(id);
  } else {
    saved = await catches.latest(guildId);
  }

  if (!saved || saved.guildId !== guildId) {
    await replyButton(interaction, 'That catch is gone.');
    return;
  }
  if (saved.userId !== interaction.user.id) {
    await replyButton(interaction, 'That’s someone else’s catch.');
    return;
  }

  const member = interaction.member;
  const voice = member instanceof GuildMember ? member.voice.channel : null;
  if (!voice) {
    await replyButton(interaction, '🔇 You need to be in a voice channel to play that.');
    return;
  }

  await interaction.deferReply();
  const who = member instanceof GuildMember ? member.displayName : interaction.user.username;
  const channel = interaction.channel?.isSendable() ? interaction.channel : null;
  const result = await playSearch(services, {
    query: `${saved.artist} ${saved.title}`.slice(0, 200),
    voiceChannel: voice,
    requestedBy: who,
    requestedById: interaction.user.id,
    announceChannel: channel,
  });
  if (!result.ok) {
    await interaction.editReply({ embeds: [buildReplyEmbed('error', result.message)] });
    return;
  }

  services.kitchen.refresh(guildId);
  const line = result.queued
    ? `➕ Queued **${plain(result.title, 80)}**.`
    : `▶️ Playing **${plain(result.title, 80)}**.`;
  await interaction.editReply({ content: line });
}
