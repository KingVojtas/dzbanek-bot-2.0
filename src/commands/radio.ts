import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { buildInfoEmbed } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { memberVoiceChannel, replyEphemeral } from './music/_util';
import { buildRadioPlayingDisplay } from '../radio/embed';
import { STATION_LIST, getStation } from '../radio/station';

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
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop the radio and leave the voice channel.'),
    ),

  async execute(interaction, services) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'play') {
      await playRadio(interaction, services);
      return;
    }
    if (sub === 'stop') {
      await stopRadio(interaction, services);
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

  const station = getStation(interaction.options.getString('station', true));
  if (!station) {
    await replyEphemeral(interaction, '❌ Unknown radio station.');
    return;
  }

  const voiceChannel = memberVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 You need to be in a voice channel to play the radio.')],
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
    const display = buildRadioPlayingDisplay(station, voiceChannel.name, {
      alreadyPlaying: true,
      track: services.radio.get(guildId)?.nowPlaying,
    });
    await interaction.reply({
      components: display.components,
      flags: display.flags,
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
    const display = buildRadioPlayingDisplay(station, voiceChannel.name, {
      track: session.nowPlaying,
    });
    await interaction.editReply({
      components: display.components,
      flags: display.flags,
    });
    const reply = await interaction.fetchReply();
    session.setNowPlayingMessage(reply);
    if (previousMessage && previousMessage.id !== reply.id) {
      await previousMessage.delete().catch(() => {
        /* already deleted */
      });
    }
  } catch (error: unknown) {
    services.logger.error(`Failed to start ${station.name}:`, error);
    const errMsg = error instanceof Error ? error.message : String(error || '');
    await interaction.editReply({
      embeds: [buildInfoEmbed(`❌ Could not start ${station.name}.\n${errMsg.slice(0, 400)}`)],
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
  await interaction.reply({
    embeds: [buildInfoEmbed(`⏹️ Stopped ${name} and left the voice channel.`)],
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
