import { prisma } from '../db/client';

/**
 * SQLite-backed set of already-posted IDs, scoped (e.g. "steam:<guildId>").
 */
export class SeenStore {
  constructor(private readonly maxPerScope: number = 500) {}

  async has(scope: string, id: string): Promise<boolean> {
    const count = await prisma.dedupEntry.count({
      where: { scope, itemId: id },
    });
    return count > 0;
  }

  async isEmpty(scope: string): Promise<boolean> {
    const count = await prisma.dedupEntry.count({ where: { scope } });
    return count === 0;
  }

  async add(scope: string, ids: string[]): Promise<void> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;

    for (const itemId of unique) {
      await prisma.dedupEntry.upsert({
        where: { scope_itemId: { scope, itemId } },
        create: { scope, itemId },
        update: {},
      });
    }

    const total = await prisma.dedupEntry.count({ where: { scope } });
    if (total <= this.maxPerScope) return;

    const oldest = await prisma.dedupEntry.findMany({
      where: { scope },
      orderBy: { createdAt: 'asc' },
      take: total - this.maxPerScope,
      select: { id: true },
    });
    if (oldest.length === 0) return;

    await prisma.dedupEntry.deleteMany({
      where: { id: { in: oldest.map((row) => row.id) } },
    });
  }
}
