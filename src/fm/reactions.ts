import type { Track } from '../core/types';
import { prisma } from '../db/client';

export type ReactionKind = 'fire' | 'nope';

export interface ReactionSong {
  songKey: string;
  url: string;
  title: string;
  artist: string;
}

export interface ReactionRow extends ReactionSong {
  userId: string;
  kind: ReactionKind;
}

export interface ToggleResult {
  /** The person's reaction after the press. Null means they took it back. */
  kind: ReactionKind | null;
  fires: number;
  nopes: number;
  /** This press is the song's first 🔥. */
  firstFire: boolean;
}

/**
 * Press 🔥 or 👎. The same one again takes it back. The other one switches.
 * One row per person per song.
 */
export function toggleReaction(
  rows: readonly ReactionRow[],
  userId: string,
  song: ReactionSong,
  kind: ReactionKind,
): { rows: ReactionRow[]; result: ToggleResult } {
  const mine = rows.find((row) => row.userId === userId && row.songKey === song.songKey);
  const firesBefore = rows.filter(
    (row) => row.songKey === song.songKey && row.kind === 'fire',
  ).length;
  const next = rows.filter((row) => !(row.userId === userId && row.songKey === song.songKey));
  const now: ReactionKind | null = mine?.kind === kind ? null : kind;
  if (now) next.push({ userId, ...song, kind: now });
  const ofSong = next.filter((row) => row.songKey === song.songKey);
  const fires = ofSong.filter((row) => row.kind === 'fire').length;
  const nopes = ofSong.filter((row) => row.kind === 'nope').length;
  return {
    rows: next,
    result: {
      kind: now,
      fires,
      nopes,
      firstFire: now === 'fire' && firesBefore === 0 && fires === 1,
    },
  };
}

/**
 * A 🔥 on a new find becomes a kitchen play, credited to that person.
 * A song the kitchen already has, or a 🔥 that is not the first, changes nothing here.
 */
export function playFromFire(
  track: Track,
  userId: string,
  known: boolean,
  firstFire: boolean,
): Track | null {
  if (known || !firstFire) return null;
  return {
    title: track.title,
    url: track.url,
    durationSec: track.durationSec,
    thumbnail: track.thumbnail,
    uploader: track.uploader,
    requestedBy: track.requestedBy,
    requestedById: userId,
    source: track.source,
  };
}

/** How many 🔥 and 👎 each song has, and the finds a 👎 should keep out of discover. */
export interface ReactionTally {
  fires: Map<string, number>;
  nopes: Map<string, number>;
  blocked: { artist: string; title: string }[];
}

/** Count one server's rows. A 👎 blocks that song from new finds. */
export function tallyReactions(
  rows: readonly Pick<ReactionRow, 'songKey' | 'kind' | 'artist' | 'title'>[],
): ReactionTally {
  const fires = new Map<string, number>();
  const nopes = new Map<string, number>();
  const blocked: { artist: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const map = row.kind === 'fire' ? fires : nopes;
    map.set(row.songKey, (map.get(row.songKey) ?? 0) + 1);
    if (row.kind !== 'nope' || seen.has(row.songKey) || !row.title) continue;
    seen.add(row.songKey);
    blocked.push({ artist: row.artist, title: row.title });
  }
  return { fires, nopes, blocked };
}

function toRow(row: {
  userId: string;
  songKey: string;
  url: string;
  title: string;
  artist: string;
  kind: string;
}): ReactionRow | null {
  if (row.kind !== 'fire' && row.kind !== 'nope') return null;
  return {
    userId: row.userId,
    songKey: row.songKey,
    url: row.url,
    title: row.title,
    artist: row.artist,
    kind: row.kind,
  };
}

/** 🔥 and 👎 for one server. One row per person per song. */
export class SongReactionStore {
  async toggle(
    guildId: string,
    userId: string,
    song: ReactionSong,
    kind: ReactionKind,
  ): Promise<ToggleResult> {
    const existing = await prisma.songReaction.findMany({
      where: { guildId, songKey: song.songKey },
    });
    const current = existing.flatMap((row) => {
      const mapped = toRow(row);
      return mapped ? [mapped] : [];
    });
    const { result } = toggleReaction(current, userId, song, kind);
    // Only this person's row changes, so two presses at once cannot erase each other.
    const mine = { guildId, userId, songKey: song.songKey };
    if (result.kind) {
      await prisma.songReaction.upsert({
        where: { guildId_userId_songKey: mine },
        create: {
          ...mine,
          url: song.url,
          title: song.title,
          artist: song.artist,
          kind: result.kind,
        },
        update: { kind: result.kind },
      });
    } else {
      await prisma.songReaction.deleteMany({ where: mine });
    }
    return result;
  }

  async fires(guildId: string, songKey: string): Promise<number> {
    return prisma.songReaction.count({ where: { guildId, songKey, kind: 'fire' } });
  }

  async tally(guildId: string): Promise<ReactionTally> {
    const rows = await prisma.songReaction.findMany({
      where: { guildId },
      select: { songKey: true, kind: true, artist: true, title: true },
    });
    return tallyReactions(
      rows.flatMap((row) =>
        row.kind === 'fire' || row.kind === 'nope' ? [{ ...row, kind: row.kind }] : [],
      ),
    );
  }
}
