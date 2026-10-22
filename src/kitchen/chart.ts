import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { prisma } from '../db/client';
import { STATION_LIST } from '../radio/station';
import {
  KITCHEN_COLOR,
  KITCHEN_HERO_FILE,
  KitchenFiles,
  VOTE_EMOJI,
  tallyBar,
  type KitchenDisplay,
} from './display';
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
}): KitchenDisplay {
  const files = new KitchenFiles();
  const container = new ContainerBuilder().setAccentColor(KITCHEN_COLOR);
  const photo = files.url(KITCHEN_HERO_FILE);
  if (photo) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(photo).setDescription('The Kitchen after dark'),
      ),
    );
  }

  const songs = ['### 🎣 Caught on the radio'];
  if (view.songs.length === 0) {
    songs.push('*Nobody caught a song this week. The radio kept playing anyway.*');
  } else {
    view.songs.forEach((song, i) => {
      const badge = ['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`;
      const times = song.names.length > 1 ? ` · caught ${song.names.length}×` : '';
      songs.push(`${badge} **${plain(song.title, 80)}** — ${plain(song.artist, 60)}`);
      songs.push(`-# ${formatNames(song.names)}${times}`);
    });
  }

  container
    .addTextDisplayComponents(
      text([`## 📬 The week in the kitchen`, `-# ${view.weekLabel} · Sunday postcard`]),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(text(songs));

  if (view.night) {
    const counts = view.night.counts;
    const total = STATION_LIST.reduce((sum, station) => sum + counts[station.id], 0);
    const night = ['### 🌙 Radio Night'];
    for (const station of STATION_LIST) {
      const label = `${VOTE_EMOJI[station.id]} ${station.choiceName.padEnd(10)}`;
      night.push(`\`${label} ${tallyBar(counts[station.id], total)}\` **${counts[station.id]}**`);
    }
    if (view.night.winnerName) {
      night.push(`🏆 **${plain(view.night.winnerName, 40)}** took the night`);
    }
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text(night));
  }

  container.addTextDisplayComponents(text(['-# 🍪 The Kitchen · see you next week']));
  return { components: [container], flags: MessageFlags.IsComponentsV2, files: files.list() };
}

function text(lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000));
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
