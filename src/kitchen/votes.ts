import { prisma } from '../db/client';
import type { StationId } from '../radio/station';
import { emptyCounts, isStationId, pickWinner, type VoteCounts } from './vote-tally';

export class RadioNightVoteStore {
  async cast(
    guildId: string,
    weekKey: string,
    userId: string,
    stationId: StationId,
  ): Promise<void> {
    await prisma.radioNightVote.upsert({
      where: { guildId_weekKey_userId: { guildId, weekKey, userId } },
      create: { guildId, weekKey, userId, stationId },
      update: { stationId },
    });
  }

  async counts(guildId: string, weekKey: string): Promise<VoteCounts> {
    const rows = await prisma.radioNightVote.findMany({
      where: { guildId, weekKey },
      select: { stationId: true },
    });
    const tallies = emptyCounts();
    for (const row of rows) {
      if (isStationId(row.stationId)) tallies[row.stationId] += 1;
    }
    return tallies;
  }

  async winner(guildId: string, weekKey: string, tieBreak: StationId): Promise<StationId> {
    return pickWinner(await this.counts(guildId, weekKey), tieBreak);
  }
}
