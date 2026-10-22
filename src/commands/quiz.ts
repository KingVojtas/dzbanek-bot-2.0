import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { buildReplyEmbed } from '../core/embeds';
import type { Command, Services } from '../core/types';
import { QUIZ_CHOICES } from '../quiz/songs';
import { memberVoiceChannel, replyEphemeral } from './music/_util';

async function start(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const guildId = interaction.guildId!;
  const voice = memberVoiceChannel(interaction);
  if (!voice) {
    await replyEphemeral(
      interaction,
      '🔇 Join a voice channel first. The quiz plays the songs there.',
    );
    return;
  }
  if (services.quiz.isActive(guildId)) {
    await replyEphemeral(interaction, '🎧 A quiz is already running. `/quiz stop` ends it.');
    return;
  }
  const text = interaction.channel?.isSendable() ? interaction.channel : null;
  if (!text) {
    await replyEphemeral(interaction, 'I cannot post the quiz in this channel.');
    return;
  }

  await interaction.deferReply();
  const playlist = interaction.options.getString('playlist')?.trim();
  const pool = playlist
    ? await services.quiz.playlistPool(playlist).catch(() => ({ songs: [], source: '' }))
    : await services.quiz.kitchenPool(guildId);
  if (pool.songs.length < QUIZ_CHOICES) {
    await interaction.editReply({
      embeds: [
        buildReplyEmbed(
          'warn',
          playlist
            ? `🎧 I could only read **${pool.songs.length}** song(s) from that playlist. The quiz needs at least ${QUIZ_CHOICES}.`
            : `🎧 The kitchen only knows **${pool.songs.length}** song(s) so far. Play some music or 🍪 catch songs off the radio, or start with \`playlist:\` and a YouTube or Spotify playlist.`,
        ),
      ],
    });
    return;
  }

  try {
    await services.quiz.start({
      voice,
      text,
      starterId: interaction.user.id,
      rounds: interaction.options.getInteger('rounds') ?? 10,
      pool,
      postLobby: (display) => interaction.editReply({ ...display, allowedMentions: { parse: [] } }),
    });
    services.kitchen.refresh(guildId);
  } catch (error) {
    services.logger.warn('Kitchen Quiz could not start:', error);
    await interaction.editReply({
      embeds: [
        buildReplyEmbed('error', `❌ ${error instanceof Error ? error.message : String(error)}`),
      ],
    });
  }
}

async function stop(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const guildId = interaction.guildId!;
  const session = services.quiz.get(guildId);
  if (!session) {
    await replyEphemeral(interaction, 'No quiz is running.', 'info');
    return;
  }
  const inChannel = memberVoiceChannel(interaction)?.id === session.voiceChannelId;
  const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!inChannel && !admin) {
    await replyEphemeral(interaction, `🔇 Join <#${session.voiceChannelId}> to stop the quiz.`);
    return;
  }
  services.quiz.stop(guildId);
  await replyEphemeral(interaction, '🏁 Quiz stopped. The podium is on the quiz card.', 'success');
}

export const quiz: Command = {
  data: new SlashCommandBuilder()
    .setName('quiz')
    .setDescription('Kitchen Quiz: name that tune in voice, from the songs the kitchen played.')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a quiz in your voice channel.')
        .addIntegerOption((option) =>
          option
            .setName('rounds')
            .setDescription('How many songs (default 10)')
            .setMinValue(5)
            .setMaxValue(20),
        )
        .addStringOption((option) =>
          option
            .setName('playlist')
            .setDescription(
              'A YouTube or Spotify playlist to quiz on instead of the kitchen songs',
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('End the quiz and show the podium.'),
    ),

  async execute(interaction, services) {
    if (!interaction.guildId) {
      await replyEphemeral(interaction, 'This command can only be used in a server.');
      return;
    }
    if (interaction.options.getSubcommand() === 'stop') await stop(interaction, services);
    else await start(interaction, services);
  },
};
