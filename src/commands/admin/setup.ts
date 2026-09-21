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
    .setDescription('Configure deal, greeting, and Kitchen Board channels for this server.')
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
        .setName('welcome')
        .setDescription('Set the channel for join messages.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel for welcome messages')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('goodbye')
        .setDescription('Set the channel for leave messages.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel for goodbye messages')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('kitchen')
        .setDescription('Set the channel for the living Kitchen Board.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel for the Kitchen Board')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('Stop posting a feature in this server.')
        .addStringOption((option) =>
          option
            .setName('feature')
            .setDescription('Which posts to disable')
            .setRequired(true)
            .addChoices(
              { name: 'Steam deals', value: 'steam' },
              { name: 'Epic free games', value: 'epic' },
              { name: 'Welcome messages', value: 'welcome' },
              { name: 'Goodbye messages', value: 'goodbye' },
              { name: 'Kitchen Board', value: 'kitchen' },
              { name: 'Radio Night', value: 'radio-night' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show deal-channel settings for this server.'),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId) {
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
      const welcome = settings.welcomeEnabled
        ? settings.welcomeChannelId
          ? `<#${settings.welcomeChannelId}>`
          : 'on · no channel yet (will auto-detect #welcome)'
        : 'disabled';
      const goodbye = settings.goodbyeEnabled
        ? settings.goodbyeChannelId
          ? `<#${settings.goodbyeChannelId}>`
          : 'on · no channel yet (will auto-detect #goodbye)'
        : 'disabled';
      const kitchen = settings.kitchenEnabled
        ? settings.kitchenChannelId
          ? `<#${settings.kitchenChannelId}>`
          : 'on · no channel yet (use /setup kitchen)'
        : 'disabled';
      const radioNight = settings.radioNightEnabled
        ? `${settings.radioNightStation ?? 'station?'} · ${
            settings.radioNightChannelId ? `<#${settings.radioNightChannelId}>` : 'no voice channel'
          } · Friday 20:00`
        : 'off';
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `**Steam deals:** ${steam}\n**Epic free games:** ${epic}\n**Welcome:** ${welcome}\n**Goodbye:** ${goodbye}\n**Kitchen Board:** ${kitchen}\n**Radio Night:** ${radioNight}\n\nUse \`/setup steam\`, \`/setup epic\`, \`/setup welcome\`, \`/setup goodbye\`, or \`/setup kitchen\` to pick a channel. Schedule Radio Night with \`/radio night\`.`,
            'Server channels',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'disable') {
      const feature = interaction.options.getString('feature', true);
      if (feature === 'kitchen') {
        const current = await store.get(guildId);
        if (current.kitchenChannelId && current.kitchenMessageId) {
          const channel = await interaction.client.channels.fetch(current.kitchenChannelId).catch(() => null);
          if (channel?.isTextBased()) {
            await channel.messages.delete(current.kitchenMessageId).catch(() => {});
          }
        }
        await store.upsert(guildId, {
          kitchenEnabled: false,
          kitchenMessageId: null,
        });
        await interaction.reply({
          embeds: [buildInfoEmbed('The Kitchen Board will no longer update in this server.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (feature === 'radio-night') {
        await store.upsert(guildId, { radioNightEnabled: false });
        services.kitchen.refresh(guildId);
        await interaction.reply({
          embeds: [buildInfoEmbed('Radio Night is off. The Kitchen Board will drop the schedule line.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const disablePatch = {
        steam: { steamEnabled: false },
        epic: { epicEnabled: false },
        welcome: { welcomeEnabled: false },
        goodbye: { goodbyeEnabled: false },
      } as const;
      await store.upsert(guildId, disablePatch[feature as keyof typeof disablePatch]);
      const labels = {
        steam: 'Steam deals will no longer post in this server.',
        epic: 'Epic free games will no longer post in this server.',
        welcome: 'Welcome messages will no longer post in this server.',
        goodbye: 'Goodbye messages will no longer post in this server.',
      };
      await interaction.reply({
        embeds: [buildInfoEmbed(labels[feature as keyof typeof labels])],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);
    const replies: Record<string, { patch: Parameters<typeof store.upsert>[1]; text: string }> = {
      steam: {
        patch: { steamEnabled: true, steamChannelId: channel.id },
        text: `Steam daily deals will post in <#${channel.id}>. New deals appear on the next scheduled poll.`,
      },
      epic: {
        patch: { epicEnabled: true, epicChannelId: channel.id },
        text: `Epic free games will post in <#${channel.id}>. A new lineup appears on the next scheduled poll.`,
      },
      welcome: {
        patch: { welcomeEnabled: true, welcomeChannelId: channel.id },
        text: `Welcome messages will post in <#${channel.id}>.`,
      },
      goodbye: {
        patch: { goodbyeEnabled: true, goodbyeChannelId: channel.id },
        text: `Goodbye messages will post in <#${channel.id}>.`,
      },
      kitchen: {
        patch: {
          kitchenEnabled: true,
          kitchenChannelId: channel.id,
          kitchenMessageId: null,
        },
        text: `The Kitchen Board will live in <#${channel.id}>. I’ll keep that one message up to date.`,
      },
    };
    const chosen = replies[sub];
    if (!chosen) return;
    await store.upsert(guildId, chosen.patch);
    await interaction.reply({ embeds: [buildInfoEmbed(chosen.text)] });
    if (sub === 'kitchen') {
      await services.kitchen.ensurePosted(guildId).catch((error) => {
        services.logger.error('Failed to post Kitchen Board:', error);
      });
    }
  },
};
