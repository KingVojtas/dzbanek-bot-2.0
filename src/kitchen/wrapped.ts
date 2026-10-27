import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import type { KitchenDisplay } from './display';
import { KITCHEN_COLOR, KITCHEN_HERO_FILE, KitchenFiles } from './display';
import { kitchenDateLabel, type KitchenPeriod, zonedParts } from './time';

/** 18:00 on the 1st. The previous month. */
export const KITCHEN_WRAPPED_MONTH_CRON = '0 18 1 * *';
/** 18:00 on 1 January. The previous year, posted after that day's month card. */
export const KITCHEN_WRAPPED_YEAR_CRON = '0 18 1 1 *';

export type WrappedWhen = 'month' | 'year';

export interface WrappedPlay {
  title: string;
  artist: string;
  songKey: string;
  requestedById: string | null;
  kind: string;
  durationSec: number;
  playedAt: Date;
}

export interface WrappedCatch {
  userId: string;
  stationId: string;
}

export interface WrappedReaction {
  songKey: string;
  title: string;
  artist: string;
  kind: string;
}

export interface KitchenWrappedView {
  label: string;
  yearly: boolean;
  since?: string;
  songs: number;
  durationSec: number;
  topSongs: { title: string; artist: string; plays: number }[];
  people: { name: string; songs: number }[];
  genre?: { name: string; share: number };
  fire?: { title: string; artist: string; fires: number };
  quiz?: { name: string; score: number; games: number };
  station?: { name: string; catches: number };
  finds?: { count: number; songs: { title: string; artist: string }[] };
}

/** "128 songs" and, once it rounds to a minute, how long that was. */
export function musicBits(
  songs: number,
  durationSec: number,
): { songs: string; length: string | null } {
  const count = Math.max(0, Math.round(songs));
  const songsLabel = count === 1 ? '1 song' : `${count.toLocaleString('en-US')} songs`;
  const seconds = Math.max(0, durationSec);
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return { songs: songsLabel, length: null };
  if (minutes < 60) {
    return {
      songs: songsLabel,
      length: minutes === 1 ? '1 minute' : `${minutes.toLocaleString('en-US')} minutes`,
    };
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return {
    songs: songsLabel,
    length: hours === 1 ? '1 hour' : `${hours.toLocaleString('en-US')} hours`,
  };
}

/**
 * The month or year, from the rows in that window.
 * People count each `play` and `dedication` once per play (a repeat counts again)
 * plus one per 🍪 catch. `fm` and `find` are the station's.
 * The favourite genre needs 5 plays with a genre. Its share is of those plays.
 * A kept find is a 🔥 on a song whose first row in this window is a `find`.
 * Older finds are not in `plays`, so they do not count. Later rows do not change the first.
 * `since` is set when the earliest play falls on a later calendar day than the period opens,
 * so a log that starts mid-month does not pretend to cover the 1st. A quiet opening day
 * does the same.
 */
export function kitchenWrapped(input: {
  period: Pick<KitchenPeriod, 'label' | 'yearly' | 'startKey'>;
  timeZone: string;
  plays: readonly WrappedPlay[];
  catches: readonly WrappedCatch[];
  reactions: readonly WrappedReaction[];
  champion: { name: string; score: number; games: number } | null;
  genreOf: (songKey: string) => string | undefined;
  nameOf: (userId: string) => string;
  stationName: (stationId: string) => string | undefined;
}): KitchenWrappedView {
  const plays = input.plays;
  const durationSec = plays.reduce((sum, row) => sum + Math.max(0, row.durationSec || 0), 0);
  const ordered = [...plays].sort(
    (a, b) => a.playedAt.getTime() - b.playedAt.getTime() || a.songKey.localeCompare(b.songKey),
  );
  let since: string | undefined;
  const first = ordered[0];
  if (first) {
    const key = zonedParts(input.timeZone, first.playedAt).dateKey;
    if (key > input.period.startKey) {
      since = kitchenDateLabel(input.timeZone, first.playedAt, input.period.yearly);
    }
  }

  return {
    label: input.period.label,
    yearly: input.period.yearly,
    since,
    songs: plays.length,
    durationSec,
    topSongs: topSongs(plays),
    people: topPeople(plays, input.catches, input.nameOf),
    genre: favouriteGenre(plays, input.genreOf),
    fire: fireSong(input.reactions),
    quiz: input.champion?.name.trim() ? input.champion : undefined,
    station: topStation(input.catches, input.stationName),
    finds: keptFinds(ordered, input.reactions),
  };
}

export function buildKitchenWrappedDisplay(view: KitchenWrappedView): KitchenDisplay {
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

  const heading = [`## 🎁 Kitchen Wrapped · ${plain(view.label, 40)}`];
  if (view.songs > 0 && view.since) heading.push(`-# since ${view.since}`);
  container.addTextDisplayComponents(text(heading));

  if (view.songs <= 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(
        text([
          view.yearly
            ? '*A quiet year. Nobody played a song, so there is nothing to wrap.*'
            : '*A quiet month. Nobody played a song, so there is nothing to wrap.*',
        ]),
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2, files: files.list() };
  }

  const bits = musicBits(view.songs, view.durationSec);
  const summary = bits.length
    ? `**${bits.songs}** · **${bits.length}** of music`
    : `**${bits.songs}**`;
  const sections: string[][] = [['### 🎵 What we played', summary]];

  if (view.topSongs.length > 0) {
    const lines = ['### 🔝 On repeat'];
    view.topSongs.forEach((song, i) => {
      const times = song.plays === 1 ? '1 play' : `${song.plays} plays`;
      const artist = plain(song.artist, 60);
      const title = `**${plain(song.title, 80)}**${artist ? ` — ${artist}` : ''}`;
      lines.push(`${medal(i)} ${title} · ${times}`);
    });
    sections.push(lines);
  }

  if (view.people.length > 0) {
    const lines = ['### 🍪 Brought the most'];
    view.people.forEach((person, i) => {
      const songs = person.songs === 1 ? '1 song' : `${person.songs} songs`;
      lines.push(`${medal(i)} **${plain(person.name, 32)}** · ${songs}`);
    });
    sections.push(lines);
  }

  if (view.genre) {
    sections.push([
      '### 🎧 Favourite genre',
      `**${plain(view.genre.name, 40)}** · ${view.genre.share}% of plays with a genre`,
    ]);
  }

  if (view.fire) {
    const artist = plain(view.fire.artist, 60);
    const title = `**${plain(view.fire.title, 80)}**${artist ? ` — ${artist}` : ''}`;
    const fires = view.fire.fires === 1 ? '1 🔥' : `${view.fire.fires} 🔥`;
    sections.push(['### 🔥 The fire song', `${title} · ${fires}`]);
  }

  if (view.quiz) {
    const games = view.quiz.games === 1 ? '1 game' : `${view.quiz.games} games`;
    sections.push([
      '### 🎧 Kitchen Quiz',
      `🏆 **${plain(view.quiz.name, 40)}** · ${view.quiz.score.toLocaleString('en-US')} points over ${games}`,
    ]);
  }

  if (view.station) {
    const catches = view.station.catches === 1 ? '1 catch' : `${view.station.catches} catches`;
    sections.push(['### 📻 Caught most', `**${plain(view.station.name, 40)}** · ${catches}`]);
  }

  if (view.finds && view.finds.count > 0) {
    const noun =
      view.finds.count === 1 ? '1 new find stayed' : `${view.finds.count} new finds stayed`;
    const lines = ['### ✨ New finds that stayed', `**${noun}** in the kitchen`];
    if (view.finds.songs.length > 0) {
      const named = view.finds.songs
        .map((song) => {
          const artist = plain(song.artist, 40);
          return `**${plain(song.title, 60)}**${artist ? ` — ${artist}` : ''}`;
        })
        .join(' · ');
      lines.push(`-# ${named}`);
    }
    sections.push(lines);
  }

  for (const lines of sections) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(text(lines));
  }
  container.addTextDisplayComponents(
    text([view.yearly ? '-# 🍪 See you next year' : '-# 🍪 See you next month']),
  );
  return { components: [container], flags: MessageFlags.IsComponentsV2, files: files.list() };
}

function topSongs(plays: readonly WrappedPlay[]): KitchenWrappedView['topSongs'] {
  const buckets = new Map<string, { title: string; artist: string; plays: number; at: number }>();
  for (const row of plays) {
    const key = row.songKey || row.title;
    const at = row.playedAt.getTime();
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { title: row.title, artist: row.artist, plays: 1, at });
      continue;
    }
    bucket.plays += 1;
    if (at >= bucket.at && row.title) {
      bucket.title = row.title;
      bucket.artist = row.artist;
      bucket.at = at;
    }
  }
  return [...buckets.values()]
    .filter((song) => song.title.trim())
    .sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title))
    .slice(0, 5)
    .map(({ title, artist, plays: count }) => ({ title, artist, plays: count }));
}

function topPeople(
  plays: readonly WrappedPlay[],
  catches: readonly WrappedCatch[],
  nameOf: (userId: string) => string,
): KitchenWrappedView['people'] {
  const brought = new Map<string, number>();
  for (const row of plays) {
    if (row.kind !== 'play' && row.kind !== 'dedication') continue;
    if (!row.requestedById) continue;
    brought.set(row.requestedById, (brought.get(row.requestedById) ?? 0) + 1);
  }
  for (const row of catches) {
    if (!row.userId) continue;
    brought.set(row.userId, (brought.get(row.userId) ?? 0) + 1);
  }
  return [...brought.entries()]
    .flatMap(([userId, songs]) => {
      const name = nameOf(userId).trim();
      return name ? [{ name, songs }] : [];
    })
    .sort((a, b) => b.songs - a.songs || a.name.localeCompare(b.name))
    .slice(0, 3);
}

/**
 * Share is this genre's plays divided by plays that have a genre, as a percent.
 * Hidden until at least 5 plays have one.
 */
function favouriteGenre(
  plays: readonly WrappedPlay[],
  genreOf: (songKey: string) => string | undefined,
): KitchenWrappedView['genre'] {
  const counts = new Map<string, number>();
  let known = 0;
  for (const row of plays) {
    const name = genreOf(row.songKey)?.trim();
    if (!name) continue;
    known += 1;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (known < 5) return undefined;
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!best) return undefined;
  return { name: best[0], share: Math.round((best[1] / known) * 100) };
}

function fireSong(reactions: readonly WrappedReaction[]): KitchenWrappedView['fire'] {
  const buckets = new Map<string, { title: string; artist: string; fires: number }>();
  for (const row of reactions) {
    if (row.kind !== 'fire' || !row.songKey) continue;
    const bucket = buckets.get(row.songKey) ?? { title: row.title, artist: row.artist, fires: 0 };
    bucket.fires += 1;
    if (row.title) {
      bucket.title = row.title;
      bucket.artist = row.artist;
    }
    buckets.set(row.songKey, bucket);
  }
  return [...buckets.values()]
    .filter((song) => song.title.trim())
    .sort((a, b) => b.fires - a.fires || a.title.localeCompare(b.title))[0];
}

/**
 * 🔥 on songs whose first play-log row in the window is a `find`.
 * The first row is the one with the earliest `playedAt`.
 */
function keptFinds(
  ordered: readonly WrappedPlay[],
  reactions: readonly WrappedReaction[],
): KitchenWrappedView['finds'] {
  const first = new Map<string, WrappedPlay>();
  for (const row of ordered) {
    if (!row.songKey || first.has(row.songKey)) continue;
    first.set(row.songKey, row);
  }
  const kept = new Map<string, { title: string; artist: string; fires: number }>();
  for (const row of reactions) {
    if (row.kind !== 'fire') continue;
    const opening = first.get(row.songKey);
    if (opening?.kind !== 'find') continue;
    const bucket = kept.get(row.songKey) ?? {
      title: opening.title,
      artist: opening.artist,
      fires: 0,
    };
    bucket.fires += 1;
    kept.set(row.songKey, bucket);
  }
  if (kept.size === 0) return undefined;
  return {
    count: kept.size,
    songs: [...kept.values()]
      .sort((a, b) => b.fires - a.fires || a.title.localeCompare(b.title))
      .slice(0, 3)
      .map(({ title, artist }) => ({ title, artist })),
  };
}

function topStation(
  catches: readonly WrappedCatch[],
  stationName: (stationId: string) => string | undefined,
): KitchenWrappedView['station'] {
  const counts = new Map<string, number>();
  for (const row of catches) {
    if (!row.stationId) continue;
    counts.set(row.stationId, (counts.get(row.stationId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .flatMap(([id, count]) => {
      const name = stationName(id)?.trim();
      return name ? [{ name, catches: count }] : [];
    })
    .sort((a, b) => b.catches - a.catches || a.name.localeCompare(b.name))[0];
}

function medal(index: number): string {
  return ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
}

function text(lines: string[]): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 4000));
}

function plain(value: string, max: number): string {
  return value
    .replace(/[\r\n*`_~|#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
