import { EmbedBuilder } from 'discord.js';
import { config } from '../config';
import type { Track } from './types';

/**
 * Generic short reply embed (errors, confirmations, status).
 * Prefer domain-specific builders (track, queue, deals) when available.
 */
export function buildInfoEmbed(description: string, title?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setDescription(description.slice(0, 4096));
  if (title) embed.setTitle(title.slice(0, 256));
  return embed;
}

/** Format a duration in seconds as `m:ss` or `h:mm:ss`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Live / Unknown';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((value, i) => (i === 0 ? String(value) : String(value).padStart(2, '0')))
    .join(':');
}

/** Human friendly view count e.g. "1.2M" or "3.4K". */
export function formatViews(count?: number): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M views';
  if (count >= 10_000) return Math.floor(count / 1_000) + 'K views';
  if (count >= 1_000) return (count / 1_000).toFixed(1).replace(/\.0$/, '') + 'K views';
  return count.toLocaleString() + ' views';
}

/** Embed for a single track (used by /play and now-playing). `label` is the author line. */
export function buildTrackEmbed(track: Track, label: string): EmbedBuilder {
  const color = track.source === 'spotify' ? 0x1db954 : config.embedColor;
  const pageUrl = track.sourceUrl || track.url;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: label })
    .setTitle(track.title.slice(0, 256))
    .setURL(pageUrl);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Duration', value: formatDuration(track.durationSec), inline: true },
    { name: 'Requested by', value: track.requestedBy, inline: true },
  ];

  if (track.uploader) {
    fields.push({ name: 'Uploader', value: track.uploader.slice(0, 100), inline: true });
  }

  const viewsStr = formatViews(track.views);
  if (viewsStr) {
    fields.push({ name: 'Views', value: viewsStr, inline: true });
  }

  if (track.uploadedAt) {
    fields.push({ name: 'Uploaded', value: track.uploadedAt, inline: true });
  }

  if (track.source && track.source !== 'youtube') {
    const badge = track.source === 'spotify' ? 'Spotify' : track.source;
    fields.push({ name: 'Source', value: badge, inline: true });
  }

  embed.addFields(fields);

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

/** Tracks shown per page in `/queue` (use buttons to flip pages). */
export const QUEUE_PAGE_SIZE = 8;

/**
 * Embed listing the current track and a page of upcoming items.
 * @param page 0-based page index into the upcoming queue.
 */
export function buildQueueEmbed(current: Track | null, queue: Track[], page = 0): EmbedBuilder {
  const pageSize = QUEUE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(queue.length / pageSize) || 1);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  const pageTracks = queue.slice(start, start + pageSize);

  let remainingSec = 0;
  for (const t of queue) {
    if (t.durationSec > 0) remainingSec += t.durationSec;
  }
  if (current && current.durationSec > 0) remainingSec += current.durationSec;

  const lines: string[] = [];

  if (current) {
    const npUrl = current.sourceUrl || current.url;
    const artist = current.uploader ? ` — *${current.uploader.slice(0, 60)}*` : '';
    lines.push(
      `▶ **Now playing**`,
      `[**${current.title.slice(0, 80)}**](${npUrl})${artist}`,
      `\`${formatDuration(current.durationSec)}\` · ${current.requestedBy}`,
    );
  } else {
    lines.push('▶ **Nothing playing**');
  }

  if (queue.length > 0) {
    lines.push('', `**Up next** · page **${safePage + 1}/${totalPages}**`);
    pageTracks.forEach((track, i) => {
      const n = start + i + 1;
      const url = track.sourceUrl || track.url;
      const title = track.title.slice(0, 70);
      const artist = track.uploader ? ` · ${track.uploader.slice(0, 40)}` : '';
      lines.push(
        `\` ${String(n).padStart(2, ' ')} \` [${title}](${url}) \`${formatDuration(track.durationSec)}\`${artist}`,
      );
    });
  } else if (current) {
    lines.push('', '*Queue is empty after this track.*');
  }

  const color = current?.source === 'spotify' ? 0x1db954 : config.embedColor;

  const footerParts: string[] = [];
  footerParts.push(`${queue.length} queued`);
  if (remainingSec > 0) footerParts.push(`~${formatDuration(remainingSec)} left`);
  footerParts.push(`Page ${safePage + 1}/${totalPages}`);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎶 Music Queue')
    .setDescription(lines.length > 0 ? lines.join('\n').slice(0, 4096) : 'The queue is empty.')
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  if (current?.thumbnail) embed.setThumbnail(current.thumbnail);

  return embed;
}

/** Total pages for an upcoming queue list. */
export function queueTotalPages(queueLength: number, pageSize = QUEUE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, queueLength) / pageSize) || 1);
}
