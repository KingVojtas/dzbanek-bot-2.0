import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  GuildMember,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Collection,
  type InteractionReplyOptions,
} from 'discord.js';
import { QUEUE_BUTTON_PREFIX, queueButtons } from '../commands/music/queue';
import {
  QUEUE_PAGE_SIZE,
  buildInfoEmbed,
  buildQueueEmbed,
  queueTotalPages,
  upcomingQueue,
} from '../core/embeds';
import type { Command, Services } from '../core/types';
import { RadioCatchStore } from '../kitchen/catches';
import { CATCH_PLAY_PREFIX, RADIO_VOTE_PREFIX } from '../kitchen/display';
import { isStationId } from '../kitchen/votes';
import type { GuildPlayer } from '../music/GuildPlayer';
import { playSearch } from '../music/play-search';
import { catchBlockReason } from '../radio/now-playing';

const catches = new RadioCatchStore();

export function registerInteractionCreate(
  client: Client,
  commands: Collection<string, Command>,
  services: Services,
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) {
          services.logger.warn(`Unknown command: /${interaction.commandName}`);
          return;
        }
        await command.execute(interaction, services);
        return;
      }

      if (interaction.isButton()) {
        await handleButton(interaction, services);
      }
    } catch (error) {
      services.logger.error('Interaction handler failed:', error);
      const payload: InteractionReplyOptions = {
        content: 'Something went wrong while running that command.',
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
    }
  });
}

async function handleButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId.startsWith('music:')) {
    await handleMusicButton(interaction, services);
    return;
  }

  if (interaction.customId.startsWith('radio:')) {
    await handleRadioButton(interaction, services);
    return;
  }

  if (interaction.customId.startsWith(RADIO_VOTE_PREFIX)) {
    await handleRadioVoteButton(interaction, services);
    return;
  }

  if (
    interaction.customId === CATCH_PLAY_PREFIX ||
    interaction.customId.startsWith(`${CATCH_PLAY_PREFIX}:`)
  ) {
    await handleCatchPlay(interaction, services);
    return;
  }

  if (!interaction.customId.startsWith(QUEUE_BUTTON_PREFIX)) return;

  const page = Number.parseInt(interaction.customId.slice(QUEUE_BUTTON_PREFIX.length), 10);
  if (!Number.isFinite(page) || !interaction.guildId) {
    await interaction.deferUpdate();
    return;
  }

  const player = services.music.get(interaction.guildId);
  if (!player) {
    await interaction.update({
      content: 'The queue is no longer active.',
      embeds: [],
      components: [],
    });
    return;
  }

  const totalPages = queueTotalPages(
    upcomingQueue(player.current, player.queue).length,
    QUEUE_PAGE_SIZE,
  );
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  await interaction.update({
    embeds: [buildQueueEmbed(player.current, player.queue, safePage)],
    components: [queueButtons(safePage, totalPages)],
  });
}

async function handleMusicButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildInfoEmbed('This can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const player = services.music.get(guildId);
  if (!player || !player.current) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 Nothing is playing right now.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!inSameVoice(interaction, player)) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 Join the voice channel the bot is in to use these controls.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = interaction.customId;

  if (id === 'music:stop') {
    await interaction.deferUpdate();
    player.stop();
    services.kitchen.refresh(guildId);
    return;
  }

  if (id === 'music:skip') {
    await interaction.deferUpdate();
    player.skip();
    return;
  }

  if (id === 'music:pause') {
    player.pause();
  } else if (id === 'music:resume') {
    player.resume();
  } else if (id === 'music:loop') {
    player.cycleLoopMode();
  } else if (id === 'music:shuffle') {
    const n = player.shuffle();
    if (n === 0) {
      await interaction.reply({
        embeds: [buildInfoEmbed('⚠️ Need at least 2 queued tracks to shuffle.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    await interaction.deferUpdate();
    return;
  }

  const display = player.buildNowPlayingPanel();
  await interaction.update({
    components: display.components,
    flags: display.flags,
  });
}

async function handleRadioButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildInfoEmbed('This can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === 'radio:catch') {
    await handleRadioCatch(interaction, services);
    return;
  }

  if (interaction.customId !== 'radio:stop') {
    await interaction.deferUpdate();
    return;
  }

  if (!services.radio.isPlaying(guildId)) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 Radio is not playing right now.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  const botChannelId = services.radio.channelId(guildId);
  if (
    !(member instanceof GuildMember) ||
    !botChannelId ||
    member.voice.channelId !== botChannelId
  ) {
    await interaction.reply({
      embeds: [buildInfoEmbed('🔇 Join the voice channel the bot is in to use this control.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  services.radio.stop(guildId);
  services.kitchen.refresh(guildId);
}

async function handleRadioVoteButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [buildInfoEmbed('This can only be used in a server.')],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const stationId = interaction.customId.slice(RADIO_VOTE_PREFIX.length);
  if (!isStationId(stationId)) {
    await interaction.deferUpdate();
    return;
  }

  const result = await services.kitchen.castVote(guildId, interaction.user.id, stationId);
  if (!result.ok) {
    await interaction.reply({
      embeds: [buildInfoEmbed(result.reason)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
}

async function handleRadioCatch(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyButton(interaction, 'This can only be used in a server.');
    return;
  }

  const session = services.radio.get(guildId);
  if (!session || !services.radio.isPlaying(guildId)) {
    await replyButton(interaction, '🔇 Radio isn’t on.');
    return;
  }

  const track = session.nowPlaying;
  const reason = catchBlockReason(track, session.station);
  if (reason || !track?.artist) {
    await replyButton(interaction, reason ?? 'That’s the show, not a song.');
    return;
  }

  await interaction.deferReply();
  const saved = await catches.save({
    guildId,
    userId: interaction.user.id,
    stationId: session.station.id,
    artist: track.artist,
    title: track.title,
    coverUrl: track.coverUrl,
  });
  const who =
    interaction.member instanceof GuildMember
      ? interaction.member.displayName
      : interaction.user.username;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CATCH_PLAY_PREFIX}:${saved.id}`)
      .setLabel('Play')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary),
  );
  await interaction.editReply({
    content: `🍪 **${plain(who, 32)}** caught **${plain(track.title, 80)}** — ${plain(track.artist, 80)}`,
    components: [row],
  });
  services.kitchen.refresh(guildId);
}

async function handleCatchPlay(interaction: ButtonInteraction, services: Services): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyButton(interaction, 'This can only be used in a server.');
    return;
  }

  const raw = interaction.customId.slice(CATCH_PLAY_PREFIX.length);
  let saved;
  if (raw.startsWith(':')) {
    const id = Number.parseInt(raw.slice(1), 10);
    if (!Number.isFinite(id)) {
      await replyButton(interaction, 'That catch is gone.');
      return;
    }
    saved = await catches.get(id);
  } else {
    saved = await catches.latest(guildId);
  }

  if (!saved || saved.guildId !== guildId) {
    await replyButton(interaction, 'That catch is gone.');
    return;
  }
  if (saved.userId !== interaction.user.id) {
    await replyButton(interaction, 'That’s someone else’s catch.');
    return;
  }

  const member = interaction.member;
  const voice = member instanceof GuildMember ? member.voice.channel : null;
  if (!voice) {
    await replyButton(interaction, '🔇 You need to be in a voice channel to play that.');
    return;
  }

  await interaction.deferReply();
  const who = member instanceof GuildMember ? member.displayName : interaction.user.username;
  const channel = interaction.channel?.isSendable() ? interaction.channel : null;
  const result = await playSearch(services, {
    query: `${saved.artist} ${saved.title}`.slice(0, 200),
    voiceChannel: voice,
    requestedBy: who,
    requestedById: interaction.user.id,
    announceChannel: channel,
  });
  if (!result.ok) {
    await interaction.editReply({ embeds: [buildInfoEmbed(result.message)] });
    return;
  }

  services.kitchen.refresh(guildId);
  const line = result.queued
    ? `➕ Queued **${plain(result.title, 80)}**.`
    : `▶️ Playing **${plain(result.title, 80)}**.`;
  await interaction.editReply({ content: line });
}

async function replyButton(interaction: ButtonInteraction, description: string): Promise<void> {
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

function plain(value: string, max: number): string {
  return value
    .replace(/[\r\n*`_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function inSameVoice(interaction: ButtonInteraction, player: GuildPlayer): boolean {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) return false;
  return member.voice.channelId === player.connection.joinConfig.channelId;
}
