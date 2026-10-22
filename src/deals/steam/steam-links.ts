import { prisma } from '../../db/client';

export interface SteamLinkRow {
  userId: string;
  steamId: string;
}

/** Discord user → SteamID64, for Wishlist Radar. */
export class SteamLinkStore {
  async get(userId: string): Promise<SteamLinkRow | null> {
    return prisma.steamLink.findUnique({
      where: { userId },
      select: { userId: true, steamId: true },
    });
  }

  async all(): Promise<SteamLinkRow[]> {
    return prisma.steamLink.findMany({ select: { userId: true, steamId: true } });
  }

  async set(userId: string, steamId: string): Promise<void> {
    await prisma.steamLink.upsert({
      where: { userId },
      create: { userId, steamId },
      update: { steamId, linkedAt: new Date() },
    });
  }

  /** False when there was nothing to remove. */
  async remove(userId: string): Promise<boolean> {
    const { count } = await prisma.steamLink.deleteMany({ where: { userId } });
    return count > 0;
  }
}
