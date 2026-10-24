import {
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type InteractionReplyOptions,
} from 'discord.js';
import { buildReplyEmbed, type EmbedCard, type ReplyTone } from '../../core/embeds';
import type { GuildPlayer } from '../../music/GuildPlayer';

/**
 * Cards posted before the switch to embeds are Components V2 messages, and
 * Discord will not edit one into an embed. Those get the fresh card privately.
 */
export async function updateCard(interaction: ButtonInteraction, card: EmbedCard): Promise<void> {
  if (interaction.message.flags.has(MessageFlags.IsComponentsV2)) {
    await interaction.reply({
      embeds: card.embeds,
      components: card.components,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.update({ embeds: card.embeds, components: card.components });
}

export async function replyButton(
  interaction: ButtonInteraction,
  description: string,
  tone: ReplyTone = 'warn',
): Promise<void> {
  const payload: InteractionReplyOptions = {
    embeds: [buildReplyEmbed(tone, description)],
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

export function plain(value: string, max: number): string {
  return value
    .replace(/[\r\n*`_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function inSameVoice(interaction: ButtonInteraction, player: GuildPlayer): boolean {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) return false;
  return member.voice.channelId === player.connection.joinConfig.channelId;
}
