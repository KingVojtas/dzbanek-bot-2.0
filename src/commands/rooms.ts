import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { buildInfoEmbed } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { decorateChannelName, type RoomKind } from '../rooms/channel-name';

export const textRoom: Command = roomCommand('text');
export const voiceRoom: Command = roomCommand('voice');

function roomCommand(kind: RoomKind): Command {
  const voice = kind === 'voice';
  return {
    data: new SlashCommandBuilder()
      .setName(voice ? 'voiceroom' : 'textroom')
      .setDescription(
        voice
          ? 'Create a voice room in a category, with an emoji in the name.'
          : 'Create a text room in a category, with an emoji in the name.',
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Room name. An emoji is added for you.')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(80),
      )
      .addChannelOption((option) =>
        option
          .setName('category')
          .setDescription('Category section this room goes under.')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      ),

    execute(interaction, services) {
      return createRoom(interaction, services, kind);
    },
  };
}

async function createRoom(
  interaction: ChatInputCommandInteraction,
  services: Services,
  kind: RoomKind,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await reply(interaction, 'This command can only be used in a server.');
    return;
  }

  const decorated = decorateChannelName(interaction.options.getString('name', true), kind);
  if (!decorated) {
    await reply(interaction, 'That name needs at least one letter or number.');
    return;
  }

  const selected = interaction.options.getChannel('category', true);
  const category = await guild.channels.fetch(selected.id).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    await reply(interaction, 'Pick a category section.');
    return;
  }

  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!category.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)) {
    await reply(interaction, 'I need **Manage Channels** in that category to open a room.');
    return;
  }

  await guild.channels.fetch().catch(() => null);
  const duplicate = guild.channels.cache.find(
    (channel) => channel.parentId === category.id && channel.name === decorated.name,
  );
  if (duplicate) {
    await reply(interaction, `${duplicate} is already in ${category}.`);
    return;
  }

  try {
    const created = await guild.channels.create({
      name: decorated.name,
      type: kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: category.id,
      reason: `/${kind === 'voice' ? 'voiceroom' : 'textroom'} by ${interaction.user.tag}`,
    });
    await reply(interaction, `Created ${created} in ${category}.`);
  } catch (error) {
    services.logger.error('Failed to create room:', error);
    const errMsg = error instanceof Error ? error.message : String(error || '');
    await reply(interaction, `Could not create that room.\n${errMsg.slice(0, 400)}`);
  }
}

function reply(interaction: ChatInputCommandInteraction, description: string): Promise<unknown> {
  return interaction.reply({
    embeds: [buildInfoEmbed(description)],
    flags: MessageFlags.Ephemeral,
  });
}
