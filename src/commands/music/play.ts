import {
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
} from 'discord.js';
import { buildQueuedTrackDisplay } from '../../core/display';
import { buildReplyEmbed, formatDuration } from '../../core/embeds';
import type { GuildPlayer } from '../../music/GuildPlayer';
import { isSpotifyAlbumUrl, isSpotifyPlaylistUrl } from '../../music/sources';
import { youtubeBotCheckHint } from '../../music/ytdlp-cookies';
import type { Command, Services, Track } from '../../core/types';

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play from YouTube or Spotify (URL or search terms).')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('A YouTube/Spotify URL or search terms')
        .setRequired(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('play_next')
        .setDescription('Insert at the front of the queue (play after the current track)')
        .setRequired(false),
    ),

  async execute(interaction, services) {
    const member = interaction.member;
    const voiceChannel = member instanceof GuildMember ? member.voice.channel : null;
    if (!voiceChannel) {
      await interaction.reply({
        embeds: [buildReplyEmbed('warn', '🔇 You need to be in a voice channel to play music.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    const isSpotifyCollection = isSpotifyPlaylistUrl(query) || isSpotifyAlbumUrl(query);
    const guildId = interaction.guildId;
    if (guildId) services.radio.stop(guildId);

    if (isSpotifyCollection) {
      await playCollection(interaction, services, voiceChannel, query);
      return;
    }

    // A YouTube link starts downloading while its title is still being read.
    services.music.trackSource.warm(query);
    const alreadyPlaying = Boolean(guildId && services.music.get(guildId)?.current);

    let tracks: Track[];
    let player: Awaited<ReturnType<typeof services.music.join>>;
    try {
      [tracks, player] = await Promise.all([
        services.music.trackSource.resolve(query, interaction.user.displayName),
        services.music.join(voiceChannel),
      ]);
    } catch (error: unknown) {
      services.logger.error('Failed to resolve/join for /play:', error);
      if (!alreadyPlaying && guildId) {
        const leftover = services.music.get(guildId);
        if (leftover && !leftover.current) leftover.stop();
      }
      await interaction.editReply({ embeds: [buildReplyEmbed('error', loadErrorMessage(error))] });
      return;
    }

    if (tracks.length === 0) {
      if (!alreadyPlaying && !player.current && player.queue.length === 0) {
        player.stop();
      }
      await interaction.editReply({
        embeds: [buildReplyEmbed('warn', '🔍 No results found for your query.')],
      });
      return;
    }

    for (const t of tracks) {
      t.requestedById = interaction.user.id;
    }

    const wasIdle = !player.current && player.queue.length === 0;
    const hadCurrent = !!player.current;
    const playNext = interaction.options.getBoolean('play_next') ?? false;

    const room = services.config.music.maxQueueSize - player.queue.length;
    const accepted = tracks.slice(0, Math.max(0, room));
    if (accepted.length === 0) {
      await interaction.editReply({
        embeds: [
          buildReplyEmbed('warn', '⚠️ The queue is full. Try again once some tracks have played.'),
        ],
      });
      return;
    }

    if (interaction.channel?.isSendable()) {
      player.setAnnounceChannel(interaction.channel);
    }

    if (playNext && !wasIdle) {
      player.enqueueNext(accepted);
    } else {
      player.enqueue(accepted);
    }

    if (wasIdle && accepted.length >= 1) {
      const attempt = await player.waitForPlaybackAttempt(20_000);
      if (!attempt.ok) {
        const hint = attempt.error ? youtubeBotCheckHint(attempt.error) : null;
        await interaction.editReply({
          embeds: [
            buildReplyEmbed(
              'error',
              hint ??
                `❌ Could not play **${accepted[0].title}**.\n${attempt.error?.slice(0, 400) ?? 'Unknown stream error.'}`,
            ),
          ],
        });
        return;
      }

      for (let i = 0; i < 20 && !player.getNowPlayingMessage(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      if (player.getNowPlayingMessage()) {
        try {
          await interaction.deleteReply();
        } catch {
          /* may already be gone */
        }
        if (accepted.length > 1) {
          await interaction
            .followUp({
              embeds: [
                buildReplyEmbed(
                  'success',
                  `🎶 Queued **${accepted.length}** tracks · now playing **${player.current?.title ?? accepted[0].title}**. Use \`/queue\` to browse.`,
                ),
              ],
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        return;
      }

      if (player.current) {
        const display = player.buildNowPlayingPanel();
        await interaction.editReply({ embeds: display.embeds, components: display.components });
        return;
      }
    }

    const added = accepted[0];
    if (accepted.length === 1 && added) {
      const label = playNext ? 'Play next' : 'Added to queue';
      let footer: string | undefined;
      if (playNext) {
        footer = `Up next after current · ${player.queue.length} still in queue`;
      } else {
        const addedIdx = player.queue.length - 1;
        const ahead = (hadCurrent && player.current ? 1 : 0) + addedIdx;
        const position = ahead + 1;
        let waitSec = 0;
        if (hadCurrent && player.current) waitSec += player.current.durationSec || 0;
        for (let i = 0; i < addedIdx; i++) {
          const t = player.queue[i];
          if (t) waitSec += t.durationSec || 0;
        }
        footer = `Position #${position}${waitSec > 0 ? ` · ~${formatDuration(waitSec)} until it starts` : ''}`;
      }
      const display = buildQueuedTrackDisplay(added, { label, footer });
      await interaction.editReply({
        components: display.components,
        flags: display.flags,
      });
      return;
    }

    const firstAddedIdx = player.queue.length - accepted.length;
    const aheadForFirst = (hadCurrent && player.current ? 1 : 0) + firstAddedIdx;
    const firstPos = aheadForFirst + 1;
    await interaction.editReply({
      embeds: [
        buildReplyEmbed(
          'success',
          `➕ Added **${accepted.length}** tracks to the queue. First one is at position **#${firstPos}**.`,
        ),
      ],
    });
  },
};

function loadErrorMessage(error: unknown): string {
  const errMsg = error instanceof Error ? error.message : String(error || '');
  const hint = youtubeBotCheckHint(errMsg);
  if (hint) return hint;
  if (/SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required/i.test(errMsg)) {
    return '❌ Spotify playlists/albums need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.';
  }
  return `❌ Could not load that track or join voice.\n${errMsg.slice(0, 400)}`;
}

/**
 * Spotify album or playlist: the first match starts playing while the rest
 * are still being found, and later matches join the queue in list order.
 */
async function playCollection(
  interaction: ChatInputCommandInteraction,
  services: Services,
  voiceChannel: VoiceBasedChannel,
  query: string,
): Promise<void> {
  const guildId = voiceChannel.guild.id;
  const playNext = interaction.options.getBoolean('play_next') ?? false;
  const alreadyPlaying = Boolean(services.music.get(guildId)?.current);

  await interaction.editReply({
    embeds: [
      buildReplyEmbed(
        'info',
        '🔍 Finding the playlist on YouTube… the first song starts as soon as it’s found.',
      ),
    ],
  });

  let player: GuildPlayer | null = null;
  let wasIdle = true;
  let lastInserted: Track | null = null;
  let queued = 0;
  let firstTitle: string | null = null;
  let gone = false;
  const pending: Track[][] = [];

  const add = (tracks: Track[]) => {
    if (gone || !player) return;
    // /stop, or another /play replaced the player: the rest of the list is not wanted.
    if (services.music.get(guildId) !== player) {
      gone = true;
      return;
    }
    const room = services.config.music.maxQueueSize - player.queue.length;
    const accepted = tracks.slice(0, Math.max(0, room));
    if (accepted.length === 0) return;
    for (const track of accepted) track.requestedById = interaction.user.id;

    if (playNext && !wasIdle) {
      if (lastInserted) player.enqueueAfter(lastInserted, accepted);
      else player.enqueueNext(accepted);
      lastInserted = accepted[accepted.length - 1] ?? lastInserted;
    } else {
      player.enqueue(accepted);
    }
    if (queued === 0) {
      firstTitle = accepted[0]?.title ?? null;
      void interaction
        .editReply({
          embeds: [
            buildReplyEmbed(
              'info',
              `🎶 ${wasIdle ? 'Starting' : 'Queued'} **${firstTitle}** · finding the rest of the list…`,
            ),
          ],
        })
        .catch(() => {});
      services.kitchen.refresh(guildId);
    }
    queued += accepted.length;
  };

  const onTracks = (tracks: Track[]) => {
    if (player) add(tracks);
    else pending.push(tracks);
  };

  let result: { total: number; matched: number };
  try {
    const joined = services.music.join(voiceChannel).then((joinedPlayer) => {
      player = joinedPlayer;
      wasIdle = !joinedPlayer.current && joinedPlayer.queue.length === 0;
      if (interaction.channel?.isSendable()) joinedPlayer.setAnnounceChannel(interaction.channel);
      for (const batch of pending.splice(0)) add(batch);
    });
    [result] = await Promise.all([
      services.music.trackSource.resolveProgressive(query, interaction.user.displayName, onTracks),
      joined,
    ]);
  } catch (error: unknown) {
    services.logger.error('Failed to resolve/join for /play:', error);
    const leftover = services.music.get(guildId);
    if (!alreadyPlaying && leftover && !leftover.current && leftover.queue.length === 0) {
      leftover.stop();
    }
    await interaction.editReply({ embeds: [buildReplyEmbed('error', loadErrorMessage(error))] });
    return;
  }

  if (queued === 0) {
    const idle = services.music.get(guildId);
    if (!alreadyPlaying && idle && !idle.current && idle.queue.length === 0) idle.stop();
    await interaction.editReply({
      embeds: [
        buildReplyEmbed(
          'warn',
          gone
            ? '⏹️ Playback stopped before the playlist was found.'
            : '🔍 Spotify album/playlist loaded, but no playable YouTube matches were found.',
        ),
      ],
    });
    return;
  }

  const missed = result.total - queued;
  await interaction.editReply({
    embeds: [
      buildReplyEmbed(
        'success',
        `🎶 Queued **${queued}** of **${result.total}** tracks from the list, starting with **${firstTitle}**.` +
          (missed > 0 ? `\n-# ${missed} had no YouTube match or did not fit in the queue.` : '') +
          (gone ? '\n-# Playback stopped before the rest arrived.' : ''),
      ),
    ],
  });
}
