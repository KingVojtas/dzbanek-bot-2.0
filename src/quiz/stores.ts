import { prisma } from '../db/client';
import type { Track } from '../core/types';

/** Newest tracks kept per server for the quiz pool. */
const PLAYED_CAP = 500;

export interface PlayedTrackRow {
  url: string;
  title: string;
  uploader: string | null;
  thumbnail: string | null;
  durationSec: number;
  requestedById: string | null;
  playedAt: Date;
}

/** Every track that started playing, per server. A replay only bumps the date. */
export class PlayedTrackStore {
  async record(guildId: string, track: Track): Promise<void> {
    const data = {
      title: track.title.slice(0, 300),
      uploader: track.uploader?.slice(0, 200) ?? null,
      thumbnail: track.thumbnail ?? null,
      durationSec: Math.max(0, Math.round(track.durationSec || 0)),
      requestedById: track.requestedById ?? null,
      playedAt: new Date(),
    };
    await prisma.playedTrack.upsert({
      where: { guildId_url: { guildId, url: track.url } },
      create: { guildId, url: track.url, ...data },
      update: data,
    });
    const total = await prisma.playedTrack.count({ where: { guildId } });
    if (total <= PLAYED_CAP) return;
    const oldest = await prisma.playedTrack.findMany({
      where: { guildId },
      orderBy: { playedAt: 'asc' },
      take: total - PLAYED_CAP,
      select: { id: true },
    });
    await prisma.playedTrack.deleteMany({ where: { id: { in: oldest.map((row) => row.id) } } });
  }

  async all(guildId: string): Promise<PlayedTrackRow[]> {
    return prisma.playedTrack.findMany({
      where: { guildId },
      orderBy: { playedAt: 'desc' },
      select: {
        url: true,
        title: true,
        uploader: true,
        thumbnail: true,
        durationSec: true,
        requestedById: true,
        playedAt: true,
      },
    });
  }
}

export type PlayLogKind = 'play' | 'fm' | 'find' | 'dedication';

export interface PlayLogInput {
  guildId: string;
  url: string;
  title: string;
  artist: string;
  songKey: string;
  requestedById: string | null;
  kind: PlayLogKind;
  durationSec: number;
}

export interface PlayLogRow {
  url: string;
  title: string;
  artist: string;
  songKey: string;
  requestedById: string | null;
  kind: string;
  durationSec: number;
  playedAt: Date;
}

/** Every track start. Rows accumulate; `prune` drops what is past a year and a bit. */
export class PlayLogStore {
  async add(input: PlayLogInput): Promise<void> {
    await prisma.playLog.create({
      data: {
        guildId: input.guildId,
        url: input.url,
        title: input.title.slice(0, 300),
        artist: input.artist.slice(0, 200),
        songKey: input.songKey.slice(0, 300),
        requestedById: input.requestedById,
        kind: input.kind,
        durationSec: Math.max(0, Math.round(input.durationSec || 0)),
      },
    });
  }

  async between(guildId: string, from: Date, to: Date): Promise<PlayLogRow[]> {
    return prisma.playLog.findMany({
      where: { guildId, playedAt: { gte: from, lte: to } },
      orderBy: { playedAt: 'asc' },
      select: {
        url: true,
        title: true,
        artist: true,
        songKey: true,
        requestedById: true,
        kind: true,
        durationSec: true,
        playedAt: true,
      },
    });
  }

  /** Delete rows strictly older than `olderThan`. Returns how many went. */
  async prune(olderThan: Date): Promise<number> {
    const result = await prisma.playLog.deleteMany({ where: { playedAt: { lt: olderThan } } });
    return result.count;
  }
}

export interface QuizChampion {
  userId: string;
  score: number;
  games: number;
}

/** Kitchen Quiz results, for the Sunday postcard's champion line. */
export class QuizScoreStore {
  async save(
    guildId: string,
    rounds: number,
    players: { userId: string; score: number; correct: number }[],
  ): Promise<void> {
    if (players.length === 0) return;
    await prisma.quizScore.createMany({
      data: players.map((player) => ({ guildId, rounds, ...player })),
    });
  }

  /** Most points between `from` and `to`, summed over every game. Null for a quiet week. */
  async champion(guildId: string, from: Date, to: Date): Promise<QuizChampion | null> {
    const rows = await prisma.quizScore.groupBy({
      by: ['userId'],
      where: { guildId, playedAt: { gte: from, lte: to } },
      _sum: { score: true },
      _count: { _all: true },
    });
    const best = rows
      .map((row) => ({ userId: row.userId, score: row._sum.score ?? 0, games: row._count._all }))
      .sort((a, b) => b.score - a.score)[0];
    return best && best.score > 0 ? best : null;
  }
}
