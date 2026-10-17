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

/** Playback clock (`0:00`, `3:21`, `1:02:03`). Zero is a valid position. */
export function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((value, i) => (i === 0 ? String(value) : String(value).padStart(2, '0')))
    .join(':');
}

/** Track length: `Live / Unknown` when duration is missing. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'Live / Unknown';
  return formatClock(totalSeconds);
}

/** Human friendly view count e.g. "1.2M" or "3.4K". */
export function formatViews(count?: number): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M views';
  if (count >= 10_000) return Math.floor(count / 1_000) + 'K views';
  if (count >= 1_000) return (count / 1_000).toFixed(1).replace(/\.0$/, '') + 'K views';
  return count.toLocaleString() + ' views';
}

/** Tracks shown per page in `/queue` (use buttons to flip pages). */
export const QUEUE_PAGE_SIZE = 8;

/** Upcoming tracks only (excludes the one currently playing). */
export function upcomingQueue(current: Track | null, queue: Track[]): Track[] {
  return current ? queue.filter((track) => track !== current) : queue;
}

/** Total pages for an upcoming queue list. */
export function queueTotalPages(queueLength: number, pageSize = QUEUE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, queueLength) / pageSize) || 1);
}
