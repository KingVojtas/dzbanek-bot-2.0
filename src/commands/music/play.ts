import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildQueuedTrackDisplay } from '../../core/display';
import { buildInfoEmbed, formatDuration } from '../../core/embeds';
import { isSpotifyAlbumUrl, isSpotifyPlaylistUrl } from '../../music/sources';
import { youtubeBotCheckHint } from '../../music/ytdlp-cookies';
import type { Command, Track } from '../../core/types';

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
        embeds: [buildInfoEmbed('🔇 You need to be in a voice channel to play music.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    const isSpotifyCollection = isSpotifyPlaylistUrl(query) || isSpotifyAlbumUrl(query);
    if (isSpotifyCollection) {
      void interaction.editReply({
        embeds: [
          buildInfoEmbed('🔍 Resolving Spotify album/playlist on YouTube… this can take a bit.'),
        ],
      });
    }

    let tracks: Track[];
    let player: Awaited<ReturnType<typeof services.music.join>>;
    try {
      [tracks, player] = await Promise.all([
        services.music.trackSource.resolve(query, interaction.user.displayName),
        services.music.join(voiceChannel),
      ]);
    } catch (error: unknown) {
      services.logger.error('Failed to resolve/join for /play:', error);
      const errMsg = error instanceof Error ? error.message : String(error || '');
      const hint = youtubeBotCheckHint(errMsg);
      let msg = hint ?? null;
      if (!msg && /SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required/i.test(errMsg)) {
        msg =
          '❌ Spotify playlists/albums need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.';
      } else if (!msg) {
        msg = `❌ Could not load that track or join voice.\n${errMsg.slice(0, 400)}`;
      }
      await interaction.editReply({ embeds: [buildInfoEmbed(msg)] });
      return;
    }

    if (tracks.length === 0) {
      await interaction.editReply({
        embeds: [
          buildInfoEmbed(
            isSpotifyCollection
              ? '🔍 Spotify album/playlist loaded, but no playable YouTube matches were found.'
              : '🔍 No results found for your query.',
          ),
        ],
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
        embeds: [buildInfoEmbed('⚠️ The queue is full. Try again once some tracks have played.')],
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
      const attempt = await player.waitForPlaybackAttempt(25_000);
      if (!attempt.ok) {
        const hint = attempt.error ? youtubeBotCheckHint(attempt.error) : null;
        await interaction.editReply({
          embeds: [
            buildInfoEmbed(
              hint ??
                `❌ Could not play **${accepted[0].title}**.\n${attempt.error?.slice(0, 400) ?? 'Unknown stream error.'}`,
            ),
          ],
        });
        return;
      }

      for (let i = 0; i < 15 && !player.getNowPlayingMessage(); i++) {
        await new Promise((r) => setTimeout(r, 200));
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
                buildInfoEmbed(
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
        await interaction.editReply({
          components: display.components,
          flags: display.flags,
        });
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
        buildInfoEmbed(
          `➕ Added **${accepted.length}** tracks to the queue. First one is at position **#${firstPos}**.`,
        ),
      ],
    });
  },
};
