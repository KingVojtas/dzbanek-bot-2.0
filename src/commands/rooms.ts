import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type OverwriteResolvable,
} from 'discord.js';
import { buildReplyEmbed, type ReplyTone } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { decorateChannelName, type RoomKind } from '../rooms/channel-name';

type RoomAccess = 'public' | 'private';

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
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
      )
      .addStringOption((option) =>
        option
          .setName('access')
          .setDescription('Public follows the category. Private is hidden from non-administrators.')
          .setRequired(true)
          .addChoices({ name: 'Public', value: 'public' }, { name: 'Private', value: 'private' }),
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

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await reply(interaction, 'Only a server administrator can open a room.');
    return;
  }

  // Creating a channel can wait on a rate limit longer than Discord's 3 seconds.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const access = interaction.options.getString('access', true);
  if (!isRoomAccess(access)) {
    await reply(interaction, 'Pick Public or Private.');
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
      ...(access === 'private'
        ? { permissionOverwrites: privateOverwrites(guild.id, interaction.user.id, me.id, kind) }
        : {}),
      reason: `/${kind === 'voice' ? 'voiceroom' : 'textroom'} (${access}) by ${interaction.user.tag}`,
    });
    const visibility =
      access === 'private'
        ? 'It is private, so only administrators can see it.'
        : 'It is public to anyone who can see that category.';
    await reply(interaction, `Created ${created} in ${category}. ${visibility}`, 'success');
  } catch (error) {
    services.logger.error('Failed to create room:', error);
    const errMsg = error instanceof Error ? error.message : String(error || '');
    await reply(interaction, `Could not create that room.\n${errMsg.slice(0, 400)}`, 'error');
  }
}

function reply(
  interaction: ChatInputCommandInteraction,
  description: string,
  tone: ReplyTone = 'warn',
): Promise<unknown> {
  const embeds = [buildReplyEmbed(tone, description)];
  if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds });
  return interaction.reply({ embeds, flags: MessageFlags.Ephemeral });
}

function isRoomAccess(value: string): value is RoomAccess {
  return value === 'public' || value === 'private';
}

/** Hide the room from @everyone. Administrators still see it, and so does the bot. */
function privateOverwrites(
  everyoneId: string,
  userId: string,
  botId: string,
  kind: RoomKind,
): OverwriteResolvable[] {
  const memberAllow =
    kind === 'voice'
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
      : [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ];
  const overwrites: OverwriteResolvable[] = [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: userId, allow: memberAllow },
  ];
  if (botId !== userId) {
    overwrites.push({
      id: botId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
    });
  }
  return overwrites;
}
