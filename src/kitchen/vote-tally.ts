import { STATION_LIST, type StationId } from '../radio/station';

/** Radio Night votes per station. Pure, so the board can render it without the database. */
export type VoteCounts = Record<StationId, number>;

export function emptyCounts(): VoteCounts {
  return Object.fromEntries(STATION_LIST.map((station) => [station.id, 0])) as VoteCounts;
}

/** Every vote, across the whole catalog. */
export function voteTotal(counts: VoteCounts): number {
  return STATION_LIST.reduce((sum, station) => sum + counts[station.id], 0);
}

/** "Rock 4 · F1 1 · Paradise 4": stations with votes, in catalog order. Empty with no votes. */
export function voteTally(counts: VoteCounts): string {
  return STATION_LIST.filter((station) => counts[station.id] > 0)
    .map((station) => `${station.voteName} ${counts[station.id]}`)
    .join(' · ');
}

export function isStationId(value: string): value is StationId {
  return STATION_LIST.some((station) => station.id === value);
}

/** Most votes wins. A tie goes to `tieBreak` when it is among the tied, else the first listed. */
export function pickWinner(counts: VoteCounts, tieBreak: StationId): StationId {
  const ranked = STATION_LIST.slice().sort((a, b) => {
    const diff = counts[b.id] - counts[a.id];
    if (diff !== 0) return diff;
    if (a.id === tieBreak) return -1;
    if (b.id === tieBreak) return 1;
    return 0;
  });
  const top = ranked[0];
  if (!top || counts[top.id] === 0) return tieBreak;
  return top.id;
}

/** The station ahead right now. A tie, or no votes, has no leader yet. */
export function voteLeader(counts: VoteCounts): StationId | null {
  let best: StationId | null = null;
  for (const station of STATION_LIST) {
    const n = counts[station.id];
    if (n > 0 && (best === null || n > counts[best])) best = station.id;
  }
  if (best && STATION_LIST.some((s) => s.id !== best && counts[s.id] === counts[best!])) {
    return null;
  }
  return best;
}
