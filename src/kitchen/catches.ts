import { prisma } from '../db/client';
import { catchKeys } from '../radio/now-playing';
import type { StationId } from '../radio/station';

const JAR_CAP = 50;

export interface SavedCatch {
  id: number;
  guildId: string;
  userId: string;
  stationId: string;
  artist: string;
  title: string;
  coverUrl: string | null;
  caughtAt: Date;
}

export class RadioCatchStore {
  async save(input: {
    guildId: string;
    userId: string;
    stationId: StationId;
    artist: string;
    title: string;
    coverUrl?: string;
  }): Promise<SavedCatch> {
    const artist = input.artist.trim().slice(0, 200);
    const title = input.title.trim().slice(0, 200);
    const keys = catchKeys(artist, title);
    const coverUrl = input.coverUrl?.trim() || null;
    const row = await prisma.radioCatch.upsert({
      where: {
        guildId_userId_artistKey_titleKey: {
          guildId: input.guildId,
          userId: input.userId,
          artistKey: keys.artistKey,
          titleKey: keys.titleKey,
        },
      },
      create: {
        guildId: input.guildId,
        userId: input.userId,
        stationId: input.stationId,
        artist,
        title,
        artistKey: keys.artistKey,
        titleKey: keys.titleKey,
        coverUrl,
      },
      update: {
        stationId: input.stationId,
        artist,
        title,
        coverUrl,
        caughtAt: new Date(),
      },
    });
    await this.trim(input.guildId, input.userId);
    return row;
  }

  async latest(guildId: string): Promise<SavedCatch | null> {
    return prisma.radioCatch.findFirst({
      where: { guildId },
      orderBy: { caughtAt: 'desc' },
    });
  }

  async get(id: number): Promise<SavedCatch | null> {
    return prisma.radioCatch.findUnique({ where: { id } });
  }

  async between(
    guildId: string,
    from: Date,
    to: Date,
  ): Promise<
    Array<{
      artist: string;
      title: string;
      artistKey: string;
      titleKey: string;
      userId: string;
      caughtAt: Date;
    }>
  > {
    return prisma.radioCatch.findMany({
      where: { guildId, caughtAt: { gte: from, lte: to } },
      select: {
        artist: true,
        title: true,
        artistKey: true,
        titleKey: true,
        userId: true,
        caughtAt: true,
      },
    });
  }

  private async trim(guildId: string, userId: string): Promise<void> {
    const rows = await prisma.radioCatch.findMany({
      where: { guildId, userId },
      orderBy: { caughtAt: 'desc' },
      select: { id: true },
    });
    const extra = rows.slice(JAR_CAP).map((row) => row.id);
    if (extra.length === 0) return;
    await prisma.radioCatch.deleteMany({ where: { id: { in: extra } } });
  }
}
