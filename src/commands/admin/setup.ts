import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { SITE_CLAY, buildReplyEmbed, buildSiteEmbed } from '../../core/embeds';
import type { Command } from '../../core/types';
import { RADIO_NIGHT_LABEL } from '../../kitchen/display';
import { getStation } from '../../radio/station';

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
        .setName('wishlist')
        .setDescription('Set the channel where Wishlist Radar pings people about their sales.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel for Wishlist Radar')
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
              { name: 'Idle → radio', value: 'idle-radio' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('idle-radio')
        .setDescription('When the music queue ends, start radio instead of leaving.')
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('On by default — fade into the last station (or Beat)')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show deal-channel settings for this server.'),
    ),

  async execute(interaction, services) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildReplyEmbed('warn', 'This command can only be used in a server.')],
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
          : 'On · auto-detects #steam or #deals'
        : 'Off';
      const epic = settings.epicEnabled
        ? settings.epicChannelId
          ? `<#${settings.epicChannelId}>`
          : 'On · auto-detects #epic or #free-games'
        : 'Off';
      const welcome = settings.welcomeEnabled
        ? settings.welcomeChannelId
          ? `<#${settings.welcomeChannelId}>`
          : 'On · auto-detects #welcome'
        : 'Off';
      const goodbye = settings.goodbyeEnabled
        ? settings.goodbyeChannelId
          ? `<#${settings.goodbyeChannelId}>`
          : 'On · auto-detects #goodbye'
        : 'Off';
      const kitchen = settings.kitchenEnabled
        ? settings.kitchenChannelId
          ? `<#${settings.kitchenChannelId}>`
          : 'On · no channel yet'
        : 'Off';
      const nightStation = getStation(settings.radioNightStation ?? '');
      const radioNight = settings.radioNightEnabled
        ? [
            RADIO_NIGHT_LABEL,
            nightStation?.name ?? 'no station',
            settings.radioNightChannelId
              ? `<#${settings.radioNightChannelId}>`
              : 'no voice channel',
          ].join(' · ')
        : 'Off';
      const lastStation = getStation(settings.lastRadioStation ?? '');
      const idleRadio = settings.idleRadioEnabled
        ? `On · ${lastStation?.name ?? 'Radio Beat'}`
        : 'Off';
      const features: [string, string, boolean?][] = [
        ['💸 Steam', steam],
        ['🎁 Epic', epic],
        ['👋 Welcome', welcome],
        ['🚪 Goodbye', goodbye],
        ['🍪 Kitchen Board', kitchen],
        ['📻 Idle radio', idleRadio],
        [
          '🎯 Wishlist Radar',
          settings.wishlistChannelId
            ? `<#${settings.wishlistChannelId}>`
            : 'On · its config channel, or the Steam channel',
        ],
        ['🌙 Radio Night', radioNight, true],
      ];
      const on = features.filter(([, value]) => value !== 'Off').length;
      await interaction.reply({
        embeds: [
          buildSiteEmbed({
            color: SITE_CLAY,
            author: '⚙️ Setup',
            title: interaction.guild?.name ?? 'This server',
            description: `**${on} of ${features.length}** features on`,
            fields: features.map(([name, value, wide]) => [
              name,
              value === 'Off' ? '⚫ Off' : `🟢 ${value}`,
              wide,
            ]),
            footer: '/setup <feature> to change a channel · /radio night to schedule',
            thumbnail: interaction.guild?.iconURL({ size: 128 }) ?? undefined,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'disable') {
      const feature = interaction.options.getString('feature', true);
      if (feature === 'kitchen') {
        const current = await store.get(guildId);
        await store.upsert(guildId, {
          kitchenEnabled: false,
          kitchenMessageId: null,
        });
        await interaction.reply({
          embeds: [
            buildReplyEmbed('success', 'The Kitchen Board will no longer update in this server.'),
          ],
          flags: MessageFlags.Ephemeral,
        });
        if (current.kitchenChannelId && current.kitchenMessageId) {
          const channel = await interaction.client.channels
            .fetch(current.kitchenChannelId)
            .catch(() => null);
          if (channel?.isTextBased()) {
            await channel.messages.delete(current.kitchenMessageId).catch(() => {});
          }
        }
        return;
      }
      if (feature === 'radio-night') {
        await store.upsert(guildId, { radioNightEnabled: false });
        services.kitchen.refresh(guildId);
        await interaction.reply({
          embeds: [
            buildReplyEmbed(
              'success',
              'Radio Night is off. The Kitchen Board will drop the schedule line.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (feature === 'idle-radio') {
        await store.upsert(guildId, { idleRadioEnabled: false });
        await interaction.reply({
          embeds: [
            buildReplyEmbed(
              'success',
              'Idle → radio is off. After the music queue ends I’ll leave like before.',
            ),
          ],
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
        embeds: [buildReplyEmbed('success', labels[feature as keyof typeof labels])],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'idle-radio') {
      const enabled = interaction.options.getBoolean('enabled', true);
      await store.upsert(guildId, { idleRadioEnabled: enabled });
      await interaction.reply({
        embeds: [
          buildReplyEmbed(
            'success',
            enabled
              ? 'After the music queue goes quiet I’ll start the last radio station (or Beat) instead of leaving.'
              : 'Idle → radio is off. After the music queue ends I’ll leave like before.',
          ),
        ],
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
      wishlist: {
        patch: { wishlistChannelId: channel.id },
        text: `Wishlist Radar will post in <#${channel.id}> and ping people there when their wishlist goes on sale.`,
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
    await interaction.reply({ embeds: [buildReplyEmbed('success', chosen.text)] });
    if (sub === 'kitchen') {
      await services.kitchen.ensurePosted(guildId).catch((error) => {
        services.logger.error('Failed to post Kitchen Board:', error);
      });
    }
  },
};
