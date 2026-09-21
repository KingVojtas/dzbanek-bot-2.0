import { ContainerBuilder, MessageFlags, TextDisplayBuilder } from 'discord.js';
import type { V2Display } from '../core/display';
import { prisma } from '../db/client';
import { STATION_LIST } from '../radio/station';
import { KITCHEN_COLOR } from './display';
import type { VoteCounts } from './votes';

export const KITCHEN_CHART_CRON = '0 18 * * 0';

const NIGHT_RAN_PREFIX = 'radio-night-ran:';

export interface ChartCatchRow {
  artist: string;
  title: string;
  artistKey: string;
  titleKey: string;
  userId: string;
  caughtAt: Date;
}

export interface ChartSongLine {
  title: string;
  artist: string;
  names: string[];
}

export interface ChartNight {
  counts: VoteCounts;
  winnerName?: string;
}

export function rankCatches(
  rows: ChartCatchRow[],
  nameOf: (userId: string) => string,
): ChartSongLine[] {
  const groups = new Map<
    string,
    { artist: string; title: string; caughtAt: number; users: Map<string, number> }
  >();

  for (const row of rows) {
    const key = `${row.artistKey}|${row.titleKey}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        artist: row.artist,
        title: row.title,
        caughtAt: row.caughtAt.getTime(),
        users: new Map(),
      };
      groups.set(key, group);
    }
    if (row.caughtAt.getTime() >= group.caughtAt) {
      group.artist = row.artist;
      group.title = row.title;
      group.caughtAt = row.caughtAt.getTime();
    }
    const previous = group.users.get(row.userId);
    if (previous == null || row.caughtAt.getTime() < previous) {
      group.users.set(row.userId, row.caughtAt.getTime());
    }
  }

  return [...groups.values()]
    .map((group) => ({
      title: group.title,
      artist: group.artist,
      names: [...group.users.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([userId]) => nameOf(userId)),
    }))
    .sort((a, b) => b.names.length - a.names.length || a.title.localeCompare(b.title))
    .slice(0, 5);
}

export function buildKitchenChartDisplay(view: {
  weekLabel: string;
  songs: ChartSongLine[];
  night?: ChartNight;
}): V2Display {
  const lines = [`### ${view.weekLabel}`, '', '**Caught**'];
  if (view.songs.length === 0) {
    lines.push('*The oven stayed cold.*');
  } else {
    for (const song of view.songs) {
      lines.push(`**${plain(song.title, 80)}** — ${plain(song.artist, 60)}`);
      lines.push(`-# ${formatNames(song.names)}`);
    }
  }

  if (view.night) {
    const bits = STATION_LIST.map(
      (station) => `${station.choiceName} **${view.night!.counts[station.id]}**`,
    );
    lines.push('', '**Radio Night**', bits.join(' · '));
    if (view.night.winnerName) lines.push(`**${plain(view.night.winnerName, 40)}** won`);
  }

  lines.push('', '-# The Kitchen · this week');

  const container = new ContainerBuilder()
    .setAccentColor(KITCHEN_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000)));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** Remember which station Radio Night actually started, keyed by Friday’s date. */
export async function markRadioNightRan(
  guildId: string,
  fridayKey: string,
  stationId: string,
): Promise<void> {
  const scope = `${NIGHT_RAN_PREFIX}${guildId}`;
  const itemId = `${fridayKey}:${stationId}`;
  await prisma.dedupEntry.upsert({
    where: { scope_itemId: { scope, itemId } },
    create: { scope, itemId },
    update: {},
  });
}

export async function radioNightPlayedStation(
  guildId: string,
  fridayKey: string,
): Promise<string | null> {
  const row = await prisma.dedupEntry.findFirst({
    where: { scope: `${NIGHT_RAN_PREFIX}${guildId}`, itemId: { startsWith: `${fridayKey}:` } },
    select: { itemId: true },
  });
  if (!row) return null;
  const stationId = row.itemId.slice(fridayKey.length + 1);
  return stationId || null;
}

function formatNames(names: string[]): string {
  const known = names.map((name) => plain(name, 32)).filter(Boolean);
  const unknown = names.length - known.length;
  if (known.length === 0) return unknown > 1 ? `${unknown} people` : 'Someone';
  const shown = known.slice(0, 6);
  const hidden = known.length - shown.length + unknown;
  const bits = [...shown];
  if (hidden > 0) bits.push(`+${hidden}`);
  return bits.join(' · ');
}

function plain(value: string, max: number): string {
  return value
    .replace(/[\r\n*`_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
