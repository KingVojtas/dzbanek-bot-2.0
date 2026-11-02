import type { StationIntro } from '../core/types';

/** The next intro is written during the song before; an unprepared one gets this long. */
export const INTRO_WAIT_MS = 12_000;
/** A break asks the player to wait this long for its clip to be ready. */
export const LONG_INTRO_WAIT_MS = 60_000;

/** A wait this long is a break: the song stream stays shut until the end is near. */
export function introIsLong(waitMs: number | null): boolean {
  return (waitMs ?? 0) >= LONG_INTRO_WAIT_MS;
}

/**
 * The station speaks before this song. A repeat of the track that just started
 * gets no second intro. Narrows `station` so the caller can ask it for the line.
 */
export function stationSpeaks<T>(station: T | null, repeat: boolean): station is T {
  return station !== null && !repeat;
}

/** The card and the clip go out only when the song has not already failed. */
export function showIntroCard(
  intro: StationIntro | null,
  streamFailed: boolean,
): intro is StationIntro {
  return intro !== null && !streamFailed;
}

/** This play was replaced, or the player is gone. The stream must not start. */
export function playSuperseded(destroyed: boolean, sameGeneration: boolean): boolean {
  return destroyed || !sameGeneration;
}

/** The line logged once the audio player has the song. */
export function streamStartedLine(facts: {
  title: string;
  readySec: string;
  prefetched: boolean;
  queued: number;
}): string {
  const via = facts.prefetched ? ', prefetched' : '';
  return `Audio player started: ${facts.title} (stream ready in ${facts.readySec} s${via}; ${facts.queued} still queued)`;
}

/** A full greeting that finished after the player had stopped waiting. */
export function lateVoiceLine(seconds: string): string {
  return `Kitchen FM voice: ready after the player stopped waiting (${seconds} s)`;
}
