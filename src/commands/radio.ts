import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { buildReplyEmbed, buildSiteEmbed } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { memberVoiceChannel, replyEphemeral } from './music/_util';
import { buildRadioPlayingDisplay } from '../radio/embed';
import { RADIO_NIGHT_LABEL } from '../kitchen/display';
import { nextRadioNight } from '../kitchen/time';
import { STATION_LIST, getStation } from '../radio/station';

/** The /radio play choice for the kitchen's own station. It runs on the music player. */
const KITCHEN_FM_CHOICE = 'kitchen-fm';

export const radio: Command = {
  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Play a live radio station in a voice channel.')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Join your voice channel and start a radio station.')
        .addStringOption((option) =>
          option
            .setName('station')
            .setDescription('Which station to play')
            .setRequired(true)
            .addChoices(
              ...STATION_LIST.map((station) => ({
                name: station.choiceName,
                value: station.id,
              })),
              { name: 'Kitchen FM: your songs, with a DJ', value: KITCHEN_FM_CHOICE },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop the radio and leave the voice channel.'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('night')
        .setDescription(`Schedule Radio Night (${RADIO_NIGHT_LABEL} Prague) in a voice channel.`)
        .addStringOption((option) =>
          option
            .setName('station')
            .setDescription('Which station to start')
            .setRequired(true)
            .addChoices(
              ...STATION_LIST.map((station) => ({
                name: station.choiceName,
                value: station.id,
              })),
            ),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Voice channel to join (defaults to yours)')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('night-off').setDescription('Cancel scheduled Radio Night.'),
    ),

  async execute(interaction, services) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'play') {
      await playRadio(interaction, services);
      return;
    }
    if (sub === 'stop') {
      await stopRadio(interaction, services);
      return;
    }
    if (sub === 'night') {
      await scheduleRadioNight(interaction, services);
      return;
    }
    if (sub === 'night-off') {
      await cancelRadioNight(interaction, services);
    }
  },
};

async function playRadio(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  if (services.quiz.isActive(guildId)) {
    await replyEphemeral(interaction, '🎧 A quiz is on. `/quiz stop` ends it.');
    return;
  }

  const choice = interaction.options.getString('station', true);
  if (choice === KITCHEN_FM_CHOICE) {
    await playKitchenFm(interaction, services);
    return;
  }

  const station = getStation(choice);
  if (!station) {
    await replyEphemeral(interaction, '❌ Unknown radio station.');
    return;
  }

  const voiceChannel = memberVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      embeds: [buildReplyEmbed('warn', '🔇 You need to be in a voice channel to play the radio.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const permissionError = missingVoicePermissions(voiceChannel);
  if (permissionError) {
    await replyEphemeral(interaction, permissionError);
    return;
  }

  const alreadyThisStation =
    services.radio.isLive(guildId) &&
    services.radio.channelId(guildId) === voiceChannel.id &&
    services.radio.station(guildId)?.id === station.id;

  if (alreadyThisStation) {
    const session = services.radio.get(guildId);
    const display = buildRadioPlayingDisplay(station, {
      track: session?.nowPlaying,
      channelId: voiceChannel.id,
      since: session?.nowPlayingSince,
    });
    await interaction.reply({
      embeds: display.embeds,
      components: display.components,
    });
    return;
  }

  await interaction.deferReply();

  if (!services.radio.isPlaying(guildId)) {
    services.music.get(guildId)?.stop();
  }

  const previousMessage = services.radio.get(guildId)?.getNowPlayingMessage() ?? null;

  try {
    const session = await services.radio.play(voiceChannel, station);
    const display = buildRadioPlayingDisplay(station, {
      track: session.nowPlaying,
      channelId: voiceChannel.id,
      since: session.nowPlayingSince,
    });
    await interaction.editReply({
      embeds: display.embeds,
      components: display.components,
    });
    const reply = await interaction.fetchReply();
    session.setNowPlayingMessage(reply);
    if (previousMessage && previousMessage.id !== reply.id) {
      await previousMessage.delete().catch(() => {
        /* already deleted */
      });
    }
    services.kitchen.refresh(guildId);
  } catch (error: unknown) {
    services.logger.error(`Failed to start ${station.name}:`, error);
    const errMsg = error instanceof Error ? error.message : String(error || '');
    await interaction.editReply({
      embeds: [
        buildReplyEmbed('error', `❌ Could not start ${station.name}.\n${errMsg.slice(0, 400)}`),
      ],
    });
  }
}

async function stopRadio(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  if (!services.radio.isPlaying(guildId)) {
    if (services.fm.isOn(guildId)) {
      await stopKitchenFm(interaction, services, guildId);
      return;
    }
    await replyEphemeral(interaction, '🔇 Radio is not playing right now.');
    return;
  }

  const channel = memberVoiceChannel(interaction);
  const botChannelId = services.radio.channelId(guildId);
  if (!channel || channel.id !== botChannelId) {
    await replyEphemeral(
      interaction,
      '🔇 Join the voice channel the bot is in to use this command.',
    );
    return;
  }

  const name = services.radio.station(guildId)?.name ?? 'the radio';
  services.radio.stop(guildId);
  services.kitchen.refresh(guildId);
  await interaction.reply({
    embeds: [buildReplyEmbed('success', `⏹️ Stopped ${name} and left the voice channel.`)],
  });
}

/** Kitchen FM: the kitchen's songs on the music player, with a DJ between them. */
async function playKitchenFm(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const voiceChannel = memberVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      embeds: [buildReplyEmbed('warn', '🔇 You need to be in a voice channel for Kitchen FM.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const permissionError = missingVoicePermissions(voiceChannel);
  if (permissionError) {
    await replyEphemeral(interaction, permissionError);
    return;
  }

  await interaction.deferReply();
  services.radio.stop(voiceChannel.guild.id);
  try {
    const text = interaction.channel?.isSendable() ? interaction.channel : null;
    const songs = await services.fm.start(voiceChannel, text);
    await interaction.editReply({
      embeds: [
        buildReplyEmbed(
          'success',
          `🎙️ **Kitchen FM** is on air in <#${voiceChannel.id}>: ${songs} kitchen songs` +
            (services.fm.findsNew ? ' and a few new finds' : '') +
            ', in sets with a DJ between them.\n' +
            '-# `/play` requests go first. ⏭️ Skip cuts the DJ short. `/radio stop` ends the show.',
        ),
      ],
    });
    services.kitchen.refresh(voiceChannel.guild.id);
  } catch (error: unknown) {
    services.logger.error('Failed to start Kitchen FM:', error);
    const errMsg = error instanceof Error ? error.message : String(error || '');
    await interaction.editReply({
      embeds: [buildReplyEmbed('error', `❌ Kitchen FM could not start.\n${errMsg.slice(0, 400)}`)],
    });
  }
}

async function stopKitchenFm(
  interaction: ChatInputCommandInteraction,
  services: Services,
  guildId: string,
): Promise<void> {
  const channel = memberVoiceChannel(interaction);
  const botChannelId = services.music.get(guildId)?.connection.joinConfig.channelId;
  if (!channel || channel.id !== botChannelId) {
    await replyEphemeral(
      interaction,
      '🔇 Join the voice channel the bot is in to use this command.',
    );
    return;
  }

  services.fm.stop(guildId);
  services.kitchen.refresh(guildId);
  await interaction.reply({
    embeds: [buildReplyEmbed('success', '⏹️ Kitchen FM is off the air. See you next show.')],
  });
}

async function scheduleRadioNight(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyEphemeral(interaction, '❌ You need **Manage Server** to schedule Radio Night.');
    return;
  }

  const station = getStation(interaction.options.getString('station', true));
  if (!station) {
    await replyEphemeral(interaction, '❌ Unknown radio station.');
    return;
  }

  const pickedId = interaction.options.getChannel('channel')?.id;
  const fromOption = pickedId
    ? (interaction.guild?.channels.cache.get(pickedId) ??
      (await interaction.guild?.channels.fetch(pickedId).catch(() => null)))
    : null;
  const voiceChannel = fromOption?.isVoiceBased() ? fromOption : memberVoiceChannel(interaction);
  if (!voiceChannel) {
    await replyEphemeral(
      interaction,
      '🔇 Pick a voice channel, or join one so I know where Radio Night should start.',
    );
    return;
  }

  await services.guildSettings.upsert(guildId, {
    radioNightEnabled: true,
    radioNightChannelId: voiceChannel.id,
    radioNightStation: station.id,
  });
  services.kitchen.refresh(guildId);

  const night = nextRadioNight(services.config.timezone);
  const starts = Math.floor(night.starts.getTime() / 1000);
  const voteOpens = Math.floor(night.voteOpens.getTime() / 1000);
  const voteLine =
    night.voteOpens.getTime() <= Date.now()
      ? 'Open now on the Kitchen Board · 💋 🎸 🥁'
      : `Opens <t:${voteOpens}:R> on the Kitchen Board · 💋 🎸 🥁`;
  await interaction.reply({
    embeds: [
      buildSiteEmbed({
        color: station.color,
        author: '🌙 Radio Night',
        authorIcon: station.logoUrl,
        title: 'On the calendar',
        description: `Every ${RADIO_NIGHT_LABEL} (Prague), the kitchen tunes in together.`,
        fields: [
          ['Next one', `<t:${starts}:F>\n<t:${starts}:R>`],
          ['Channel', `<#${voiceChannel.id}>`],
          ['Tie or no votes', station.name],
          ['Vote', voteLine, true],
        ],
        footer: 'Most votes wins · /radio night-off to cancel',
        thumbnail: station.logoUrl,
      }),
    ],
  });
}

async function cancelRadioNight(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyEphemeral(interaction, '❌ You need **Manage Server** to cancel Radio Night.');
    return;
  }

  await services.guildSettings.upsert(guildId, { radioNightEnabled: false });
  services.kitchen.refresh(guildId);
  await interaction.reply({
    embeds: [buildReplyEmbed('success', '📻 Radio Night is off. I will not auto-join on Friday.')],
  });
}

function missingVoicePermissions(channel: VoiceBasedChannel): string | null {
  const me = channel.guild.members.me;
  if (!me) {
    return '❌ I could not resolve my member in this server. Try again in a moment.';
  }

  const perms = channel.permissionsFor(me);
  if (!perms) {
    return '❌ I could not read my permissions in that voice channel.';
  }

  if (!perms.has(PermissionFlagsBits.ViewChannel)) {
    return '❌ I need the **View Channel** permission in that voice channel.';
  }
  if (!perms.has(PermissionFlagsBits.Connect)) {
    return '❌ I need the **Connect** permission in that voice channel.';
  }
  if (!perms.has(PermissionFlagsBits.Speak)) {
    return '❌ I need the **Speak** permission in that voice channel.';
  }
  if (channel.userLimit > 0 && channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) {
    return '❌ That voice channel is full and I cannot join.';
  }

  return null;
}
