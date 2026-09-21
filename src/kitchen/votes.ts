import { prisma } from '../db/client';
import { STATION_LIST, type StationId } from '../radio/station';

export type VoteCounts = Record<StationId, number>;

function emptyCounts(): VoteCounts {
  return { kiss: 0, rock: 0, beat: 0 };
}

export function isStationId(value: string): value is StationId {
  return STATION_LIST.some((station) => station.id === value);
}

export class RadioNightVoteStore {
  async cast(guildId: string, weekKey: string, userId: string, stationId: StationId): Promise<void> {
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
    const tallies = await this.counts(guildId, weekKey);
    const ranked = STATION_LIST.slice().sort((a, b) => {
      const diff = tallies[b.id] - tallies[a.id];
      if (diff !== 0) return diff;
      if (a.id === tieBreak) return -1;
      if (b.id === tieBreak) return 1;
      return 0;
    });
    const top = ranked[0];
    if (!top || tallies[top.id] === 0) return tieBreak;
    return top.id;
  }
}
