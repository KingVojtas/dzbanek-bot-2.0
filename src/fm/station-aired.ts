import type { Logger } from '../core/logger';
import type { AiredSong } from '../quiz/stores';
import { prepareBlocked, type BlockedSongs, type FmSong } from './script';

/** Missed find queries kept per server. The oldest drop off once this fills. */
const DEAD_CAP = 500;
/** What Claude hears of songs already played. */
const PLAYED_SHOWN = 30;

/** `played` stores "Artist – Title". Split it back so a find is not that song again. */
export function splitPlayed(label: string): { artist: string; title: string } {
  const parts = label.split(/\s+[–—-]\s+/);
  if (parts.length >= 2 && parts[0] && parts.slice(1).join(' - ')) {
    return { artist: parts[0], title: parts.slice(1).join(' - ') };
  }
  return { artist: '', title: label };
}

/** Keys, links, and the latest play of everything `aired()` returned for one set. */
interface AiredMemory {
  keys: Set<string>;
  urls: Set<string>;
  lastByKey: Map<string, number>;
  lastByUrl: Map<string, number>;
  rows: readonly AiredSong[];
}

function emptyAired(): AiredMemory {
  return { keys: new Set(), urls: new Set(), lastByKey: new Map(), lastByUrl: new Map(), rows: [] };
}

/** The latest `playedAt` wins when the same song aired more than once. */
function indexAired(rows: readonly AiredSong[]): AiredMemory {
  const memory = emptyAired();
  memory.rows = rows;
  for (const row of rows) {
    const at = row.playedAt.getTime();
    if (row.songKey) {
      memory.keys.add(row.songKey);
      const prev = memory.lastByKey.get(row.songKey);
      if (prev === undefined || at > prev) memory.lastByKey.set(row.songKey, at);
    }
    if (row.url) {
      memory.urls.add(row.url);
      const prev = memory.lastByUrl.get(row.url);
      if (prev === undefined || at > prev) memory.lastByUrl.set(row.url, at);
    }
  }
  return memory;
}

/** What the aired log reads off the station. The show still decides which song to plan. */
export interface StationAiredDeps {
  logger: Logger;
  /**
   * Songs already aired. Read fresh for every set. A failed read counts as
   * nothing aired, and the show goes on.
   */
  aired?: () => Promise<readonly AiredSong[]>;
  /**
   * Find queries YouTube could not match. Shared by every show on this server
   * for the life of the process. The station appends to it.
   */
  deadFinds?: { artist: string; title: string }[];
  /** Labels this show already played, "Artist – Title". */
  played: () => readonly string[];
}

/**
 * What already aired, and what this show has planned, so a song is not picked
 * twice. `plannedKeys` and `plannedUrls` are the same sets for the whole show.
 */
export class StationAired {
  /** What `aired()` returned for the set being planned. */
  airedNow: AiredMemory = emptyAired();
  /** Keys and URLs this show has already planned. Uncapped, so nothing is planned twice. */
  readonly plannedKeys = new Set<string>();
  readonly plannedUrls = new Set<string>();
  /** Find queries this show noted, when the server did not hand in a shared list. */
  private readonly ownDead: { artist: string; title: string }[] = [];

  constructor(private readonly deps: StationAiredDeps) {}

  /** `fm` and `find` rows, plus today's plays. A failed read leaves the show with nothing aired. */
  async readAired(): Promise<void> {
    const read = this.deps.aired;
    if (!read) {
      this.airedNow = emptyAired();
      return;
    }
    try {
      this.airedNow = indexAired(await read());
    } catch (error: unknown) {
      this.deps.logger.warn('Kitchen FM could not read what it already aired:', error);
      this.airedNow = emptyAired();
    }
  }

  /** Aired already, or planned earlier in this show. */
  taken(song: FmSong): boolean {
    return this.plannedThisShow(song) || this.airedKitchen(song);
  }

  /** Planned earlier in this show, by pool key or link. */
  plannedThisShow(song: FmSong): boolean {
    if (this.plannedKeys.has(song.key)) return true;
    return Boolean(song.url && this.plannedUrls.has(song.url));
  }

  /** A kitchen song whose key or link is in the aired log. */
  private airedKitchen(song: FmSong): boolean {
    if (this.airedNow.keys.has(song.key)) return true;
    return Boolean(song.url && this.airedNow.urls.has(song.url));
  }

  /** Latest time this kitchen song aired. Never aired is 0, so it sorts first. */
  lastAiredAt(song: FmSong): number {
    const byKey = this.airedNow.lastByKey.get(song.key) ?? 0;
    const byUrl = song.url ? (this.airedNow.lastByUrl.get(song.url) ?? 0) : 0;
    return Math.max(byKey, byUrl);
  }

  markPlanned(key: string | undefined, url: string | undefined): void {
    if (key && key !== '|') this.plannedKeys.add(key);
    if (url) this.plannedUrls.add(url);
  }

  /** Find queries YouTube could not match, shared across shows when the server passed one in. */
  deadList(): { artist: string; title: string }[] {
    return this.deps.deadFinds ?? this.ownDead;
  }

  /** Remember a find query that YouTube could not match. A thrown search does not come here. */
  noteDead(artist: string, title: string): void {
    const list = this.deadList();
    if (list.some((song) => song.artist === artist && song.title === title)) return;
    list.push({ artist, title });
    if (list.length > DEAD_CAP) list.splice(0, list.length - DEAD_CAP);
  }

  /** Aired songs and dead finds, so Claude's crate-less names can be refused. */
  airedNames(): BlockedSongs {
    return prepareBlocked([
      ...this.airedNow.rows.map((row) => ({ artist: row.artist, title: row.title })),
      ...this.deadList(),
    ]);
  }

  /**
   * What Claude is told already played. This show first, then the most recent
   * aired songs, never more than `PLAYED_SHOWN`.
   */
  playedForClaude(): string[] {
    const own = this.deps.played().slice(-PLAYED_SHOWN);
    if (own.length >= PLAYED_SHOWN) return own;
    const seen = new Set(own.map((label) => label.toLowerCase()));
    const labels = [...own];
    const recent = [...this.airedNow.rows].sort(
      (a, b) => b.playedAt.getTime() - a.playedAt.getTime(),
    );
    for (const row of recent) {
      if (labels.length >= PLAYED_SHOWN) break;
      const label = row.artist ? `${row.artist} – ${row.title}` : row.title;
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      labels.push(label);
    }
    return labels;
  }
}
