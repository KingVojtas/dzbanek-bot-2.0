import type { HeardGreeting, StationIntro } from '../core/types';

/** A clip that has not arrived by now is skipped, so a slow decode never holds the show. */
export const OPENING_READY_MS = 2_000;

/**
 * What to do with the opening jingle once its clip promise settles:
 * - `play`: nothing else is on, and the clip arrived in time.
 * - `late`: it missed the deadline. A slow decode must not hold the show.
 * - `busy`: a song or the DJ is already on, so the jingle stays out of the way.
 * - `empty`: no clip. The station already said why.
 * - `gone`: the player was torn down.
 */
export type OpeningPlay = 'play' | 'late' | 'busy' | 'empty' | 'gone';

export function openingPlay(facts: {
  destroyed: boolean;
  busy: boolean;
  elapsedMs: number;
  hasPcm: boolean;
}): OpeningPlay {
  if (facts.destroyed) return 'gone';
  if (facts.elapsedMs >= OPENING_READY_MS) return 'late';
  if (facts.busy) return 'busy';
  if (!facts.hasPcm) return 'empty';
  return 'play';
}

/**
 * Open the song stream now. While the opening jingle is still pending, YouTube
 * starts during the jingle. Once that has settled, a long break waits unless
 * the song was already prefetched.
 */
export function openSongStreamNow(facts: {
  openingSettled: boolean;
  longIntro: boolean;
  prefetched: boolean;
}): boolean {
  if (!facts.openingSettled) return true;
  return facts.prefetched || !facts.longIntro;
}

/**
 * How long the player waits for the intro once the opening jingle has finished
 * or was skipped. Null while the jingle is still going: the wait has not started,
 * so a break's clock does not run during it.
 */
export function introWaitAfterOpening(
  openingSettled: boolean,
  stationWaitMs: number | undefined,
  usualMs: number,
): number | null {
  if (!openingSettled) return null;
  return stationWaitMs ?? usualMs;
}

/**
 * The clip to play before the song. A full greeting with audio wins. Otherwise
 * the backup clip. A text-only intro is kept so the card still shows the line.
 */
export function greetingToPlay(
  intro: StationIntro | null,
  fallback: StationIntro | null,
): { intro: StationIntro | null; heard: HeardGreeting } {
  if (intro?.pcm?.length) return { intro, heard: 'spoken' };
  if (fallback?.pcm?.length) return { intro: fallback, heard: 'backup' };
  return { intro, heard: 'none' };
}

/**
 * Idle ends the current track only when nothing else is holding the player.
 * An opening clip and the queue pump both look like Idle without a song ending.
 */
export function idleEndsTrack(facts: { clip: boolean; queueRunning: boolean }): boolean {
  return !facts.clip && !facts.queueRunning;
}

/** How the first song's greeting is named in the log. */
export type FirstSongGreeting = 'prepared' | 'fresh' | 'backup' | 'none';

/**
 * `prepared` is a full greeting voiced before the show. `fresh` was synthesized
 * during it. A backup clip is its own case, and so is silence.
 */
export function firstSongGreeting(facts: {
  heard: HeardGreeting;
  preparedClip: boolean;
}): FirstSongGreeting {
  if (facts.heard === 'backup') return 'backup';
  if (facts.heard === 'none') return 'none';
  return facts.preparedClip ? 'prepared' : 'fresh';
}
