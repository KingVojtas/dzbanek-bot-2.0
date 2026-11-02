import type { LoopMode, Track } from '../core/types';

/** A track that played less than this ended on a broken stream, not on its own. */
export const INSTANT_END_MS = 800;
/** Shorter than its length by more than this: the stream was cut off. */
export const EARLY_BY_SEC = 20;
export const HISTORY_MAX = 25;

export interface TrackEnd {
  finished: Track | null;
  playedMs: number;
  /** Skip or previous asked for this end. */
  skipRequested: boolean;
  /** previous() already put the finished track back in the queue. */
  goingBack: boolean;
  loopMode: LoopMode;
  /** URL already retried once after ending instantly. */
  retriedUrl: string | null;
}

/**
 * What the player does with the track that just ended:
 * - `retry`: it ended instantly for the first time, so play it again on a fresh stream.
 * - `give-up`: it ended instantly twice, so it goes to history and the queue moves on.
 * - `requeue`: loop-track puts it back at the front.
 * - `history`: it finished normally (or was skipped).
 * - `none`: nothing finished, or previous() already placed it.
 */
export type AfterTrackEnds = 'retry' | 'give-up' | 'requeue' | 'history' | 'none';

/** `m:ss`, or `h:mm:ss` past an hour. */
function clock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts
    .map((value, i) => (i === 0 ? String(value) : String(value).padStart(2, '0')))
    .join(':');
}

export interface EarlyEnd extends TrackEnd {
  /** The bytes came from the prefetch, not a fresh stream. */
  prefetched: boolean;
  /** stop() tore the player down as this track ended. */
  stopped: boolean;
}

/**
 * A warn line when a song ends on its own well short of its length.
 * Null for a skip, stop, previous, a retry, or a song that ran its course.
 */
export function earlyEndWarning(end: EarlyEnd): string | null {
  if (end.stopped || end.skipRequested || end.goingBack) return null;
  const how = afterTrackEnds(end);
  if (how !== 'history' && how !== 'requeue') return null;
  const durationSec = end.finished?.durationSec ?? 0;
  if (!(durationSec > 0)) return null;
  const playedSec = end.playedMs / 1000;
  if (!(durationSec - playedSec > EARLY_BY_SEC)) return null;
  const via = end.prefetched ? ' (prefetched)' : '';
  return `Track "${end.finished?.title ?? ''}" ended early: played ${clock(playedSec)} of ${clock(durationSec)}${via}.`;
}

export function afterTrackEnds(end: TrackEnd): AfterTrackEnds {
  const { finished } = end;
  const instant = finished !== null && end.playedMs < INSTANT_END_MS && !end.skipRequested;
  if (instant && end.retriedUrl !== finished.url) return 'retry';
  if (instant) return 'give-up';
  if (!finished || end.goingBack) return 'none';
  if (end.loopMode === 'track' && !end.skipRequested) return 'requeue';
  return 'history';
}

/** Append to `history`, keeping only the newest `max`. */
export function pushHistory(history: Track[], track: Track, max = HISTORY_MAX): void {
  history.push(track);
  if (history.length > max) history.splice(0, history.length - max);
}

/** Take the next track. Loop-queue refills an empty queue from its snapshot first. */
export function takeNext(queue: Track[], loopMode: LoopMode, snapshot: Track[]): Track | undefined {
  const next = queue.shift();
  if (next) return next;
  if (loopMode !== 'queue' || snapshot.length === 0) return undefined;
  queue.push(...snapshot);
  return queue.shift();
}

/** Station picks that fail in a row before the show stops trying (YouTube is down). */
export const STATION_MISSES = 3;

/** The queue is empty and the station is still allowed to offer a song. */
export function shouldAskStation(next: Track | undefined, misses: number): boolean {
  return next === undefined && misses < STATION_MISSES;
}

/** Taken off air meanwhile, or a request arrived while the station was picking. */
export function stationPickStale(sameStation: boolean, queued: number): boolean {
  return !sameStation || queued > 0;
}

/**
 * What Idle does once `afterTrackEnds` has classified the track.
 * The warn lines are the ones the player logs.
 */
export function idleOutcome(
  next: AfterTrackEnds,
  title: string,
):
  | { kind: 'retry'; warn: string }
  | { kind: 'give-up'; warn: string; error: string }
  | { kind: 'continue'; requeue: boolean; history: boolean } {
  if (next === 'retry') {
    return {
      kind: 'retry',
      warn: `Track "${title}" ended immediately — retrying with a fresh stream.`,
    };
  }
  if (next === 'give-up') {
    return {
      kind: 'give-up',
      warn: `Track "${title}" ended immediately again — skipping it.`,
      error: `"${title}" ended immediately twice.`,
    };
  }
  return { kind: 'continue', requeue: next === 'requeue', history: next === 'history' };
}
