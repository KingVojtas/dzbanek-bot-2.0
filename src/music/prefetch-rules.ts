import type { LoopMode } from '../core/types';

/** Whole song, so yt-dlp exits and closes YouTube. Songs are 3–8 MB; a 12-minute cap stays under 16 MB. */
export const PREFETCH_BYTES = 16 * 1024 * 1024;

/**
 * The bytes that arrived are for a prefetch this play no longer wants.
 * A taken slot belongs to the play that claimed it: a new generation does not
 * throw those bytes away.
 */
export function prefetchIsStale(facts: {
  drop: boolean;
  destroyed: boolean;
  taken: boolean;
  sameGeneration: boolean;
  /** Read only when the slot is still this play's and the generation matches. */
  keep: () => boolean;
}): boolean {
  return (
    facts.drop || facts.destroyed || (!facts.taken && (!facts.sameGeneration || !facts.keep()))
  );
}

/** The warmed stream is the one this play is waiting on. */
export function prefetchedStreamReady(facts: {
  drop: boolean;
  hasStream: boolean;
  usable: boolean;
  destroyed: boolean;
  sameGeneration: boolean;
}): boolean {
  return !facts.drop && facts.hasStream && facts.usable && !facts.destroyed && facts.sameGeneration;
}

/** The show's prepared opener arrived with audio. An empty buffer is not audio. */
export function hasPreloadedAudio<T extends { length: number }>(
  audio: T | null | undefined,
): audio is T {
  return Boolean(audio?.length);
}

/** A queued request is still the song this prefetch was for. */
export function queuedPrefetchKeep(queuedUrl: string | undefined, url: string): boolean {
  return queuedUrl === url;
}

/**
 * The station pick is still next. Call this only when nothing is queued:
 * a request in front is decided by `queuedPrefetchKeep`, without asking the station.
 */
export function stationPrefetchKeep(facts: {
  sameStation: boolean;
  loopMode: LoopMode;
  stationUrl: string | undefined;
  url: string;
}): boolean {
  if (!facts.sameStation || facts.loopMode !== 'off') return false;
  return facts.stationUrl === facts.url;
}

/** A station warm is dropped when the show changed, a request is waiting, or the queue loops. */
export function stationPrefetchBlocked(facts: {
  destroyed: boolean;
  sameStation: boolean;
  loopMode: LoopMode;
  requestWaiting: boolean;
}): boolean {
  return facts.destroyed || !facts.sameStation || facts.loopMode !== 'off' || facts.requestWaiting;
}

/** Looping a track or the queue plays what is already lined up, so nothing is warmed ahead. */
export function stationWarmsAhead(loopMode: LoopMode): boolean {
  return loopMode === 'off';
}

/** The pick is still the one this station prepared, and the queue is still not looping. */
export function upcomingHeld(sameStation: boolean, loopMode: LoopMode): boolean {
  return sameStation && loopMode === 'off';
}

/**
 * A station is no longer next, so a warm of some other song is dropped.
 * A queued request that is already the warmed url stays.
 */
export function dropPrefetchOnStationChange(
  queuedUrl: string | undefined,
  prefetchedUrl: string | undefined,
): boolean {
  return queuedUrl === undefined || queuedUrl !== prefetchedUrl;
}
