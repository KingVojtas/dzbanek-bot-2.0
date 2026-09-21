import type { SendableChannels, VoiceBasedChannel } from 'discord.js';
import type { Services } from '../core/types';
import { youtubeBotCheckHint } from './ytdlp-cookies';

export type PlaySearchResult =
  { ok: true; title: string; queued: boolean } | { ok: false; message: string };

/** Resolve a text search on YouTube, join voice, and queue the first match. */
export async function playSearch(
  services: Services,
  opts: {
    query: string;
    voiceChannel: VoiceBasedChannel;
    requestedBy: string;
    requestedById: string;
    announceChannel: SendableChannels | null;
  },
): Promise<PlaySearchResult> {
  const guildId = opts.voiceChannel.guild.id;
  const alreadyPlaying = Boolean(services.music.get(guildId)?.current);

  let tracks;
  let player;
  try {
    [tracks, player] = await Promise.all([
      services.music.trackSource.resolve(opts.query, opts.requestedBy),
      services.music.join(opts.voiceChannel),
    ]);
  } catch (error: unknown) {
    services.logger.error('Failed to play a catch:', error);
    if (!alreadyPlaying) {
      const leftover = services.music.get(guildId);
      if (leftover && !leftover.current) leftover.stop();
    }
    const errMsg = error instanceof Error ? error.message : String(error || '');
    return {
      ok: false,
      message: youtubeBotCheckHint(errMsg) ?? `❌ Could not play that.\n${errMsg.slice(0, 400)}`,
    };
  }

  const track = tracks[0];
  if (!track) {
    if (!alreadyPlaying && !player.current && player.queue.length === 0) player.stop();
    return { ok: false, message: '🔍 No YouTube match for that song.' };
  }

  track.requestedById = opts.requestedById;
  const wasIdle = !player.current && player.queue.length === 0;
  if (!wasIdle && player.queue.length >= services.config.music.maxQueueSize) {
    return { ok: false, message: '⚠️ The queue is full. Try again once some tracks have played.' };
  }

  if (opts.announceChannel) player.setAnnounceChannel(opts.announceChannel);
  player.enqueue([track]);

  if (wasIdle) {
    const attempt = await player.waitForPlaybackAttempt(20_000);
    if (!attempt.ok) {
      const hint = attempt.error ? youtubeBotCheckHint(attempt.error) : null;
      return {
        ok: false,
        message:
          hint ??
          `❌ Could not play **${track.title}**.\n${attempt.error?.slice(0, 400) ?? 'Unknown stream error.'}`,
      };
    }
  }

  return { ok: true, title: player.current?.title ?? track.title, queued: !wasIdle };
}
