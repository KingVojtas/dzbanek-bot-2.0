import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { buildInfoEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';

export const setup: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure Steam deals and Epic free-games channels for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('steam')
        .setDescription('Set the channel for Steam daily deals.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel to post Steam deals')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('epic')
        .setDescription('Set the channel for Epic Games free games.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel to post Epic free games')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('Stop posting Steam or Epic in this server.')
        .addStringOption((option) =>
          option
            .setName('feature')
            .setDescription('Which posts to disable')
            .setRequired(true)
            .addChoices(
              { name: 'Steam deals', value: 'steam' },
              { name: 'Epic free games', value: 'epic' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show deal-channel settings for this server.'),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId || !services.guildSettings) {
      await interaction.reply({
        embeds: [buildInfoEmbed('This command can only be used in a server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const store = services.guildSettings;

    if (sub === 'status') {
      const settings = await store.get(guildId);
      const steam = settings.steamEnabled
        ? settings.steamChannelId
          ? `<#${settings.steamChannelId}>`
          : 'on · no channel yet (will auto-detect a #steam / #deals channel)'
        : 'disabled';
      const epic = settings.epicEnabled
        ? settings.epicChannelId
          ? `<#${settings.epicChannelId}>`
          : 'on · no channel yet (will auto-detect a #epic / #free-games channel)'
        : 'disabled';
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `**Steam deals:** ${steam}\n**Epic free games:** ${epic}\n\nUse \`/setup steam\` or \`/setup epic\` to pick a channel.`,
            'Deal channels',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'disable') {
      const feature = interaction.options.getString('feature', true);
      if (feature === 'steam') {
        await store.upsert(guildId, { steamEnabled: false });
      } else {
        await store.upsert(guildId, { epicEnabled: false });
      }
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            feature === 'steam'
              ? 'Steam deals will no longer post in this server.'
              : 'Epic free games will no longer post in this server.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);
    if (sub === 'steam') {
      await store.upsert(guildId, { steamEnabled: true, steamChannelId: channel.id });
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `Steam daily deals will post in <#${channel.id}>. New deals appear on the next scheduled poll.`,
          ),
        ],
      });
      return;
    }

    await store.upsert(guildId, { epicEnabled: true, epicChannelId: channel.id });
    await interaction.reply({
      embeds: [
        buildInfoEmbed(
          `Epic free games will post in <#${channel.id}>. A new lineup appears on the next scheduled poll.`,
        ),
      ],
    });
  },
};
