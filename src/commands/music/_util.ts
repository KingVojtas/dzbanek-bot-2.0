import {
  GuildMember,
  MessageFlags,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type VoiceBasedChannel,
} from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { GuildPlayer } from '../../music/GuildPlayer';
import type { Services } from '../../core/types';

export async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  description: string,
): Promise<void> {
  const payload: InteractionReplyOptions = {
    embeds: [buildInfoEmbed(description)],
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

export function memberVoiceChannel(interaction: ChatInputCommandInteraction): VoiceBasedChannel | null {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) return null;
  return member.voice.channel;
}

/**
 * Require an active player in this guild. Optionally require the caller to share
 * the bot's voice channel (playback controls).
 */
export async function requirePlayer(
  interaction: ChatInputCommandInteraction,
  services: Services,
  opts: { sameVoice?: boolean } = {},
): Promise<GuildPlayer | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return null;
  }

  const player = services.music.get(guildId);
  if (!player || !player.current) {
    await replyEphemeral(interaction, '🔇 Nothing is playing right now.');
    return null;
  }

  if (opts.sameVoice) {
    const channel = memberVoiceChannel(interaction);
    const botChannelId = player.connection.joinConfig.channelId;
    if (!channel || channel.id !== botChannelId) {
      await replyEphemeral(interaction, '🔇 Join the voice channel the bot is in to use this command.');
      return null;
    }
  }

  return player;
}
