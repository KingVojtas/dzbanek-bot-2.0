import type { StationIntro, Track } from '../core/types';
import type { GenreId } from './genres';

/** A few songs that share a vibe. The DJ talks before the first one only. */
export interface FmSet {
  vibe: string;
  line: string;
  tracks: Track[];
  /** The next of `tracks` to hand out. */
  next: number;
  plannedAt: number;
  /** The show's first set. Its clip is synthesized before anything is playing. */
  opener?: boolean;
  /** First set of a rotation block. The break or the opener already played. */
  blockStart?: boolean;
  /** Set when the set belongs to a rotation block. */
  rotationGenre?: GenreId | null;
  /** Still loading later songs. `peek` waits for those instead of planning another set. */
  filling?: Promise<void> | null;
  /** Wakes a `peek` that ran out of loaded songs while `filling` is set. */
  wake?: (() => void) | null;
  /** PCM prepared before the show. Absent means synthesize `line` when it is asked for. */
  preparedClip?: Buffer;
  /** The break before this set. Only the first song of a later rotation block has one. */
  breakClip?: Promise<StationIntro | null>;
  /**
   * Starts the break's own deadline. Called when the player starts waiting for
   * it, not when it is planned: the song before still has minutes to run then.
   */
  breakDue?: () => void;
}

export type SetBase = { hour: number; minute: number; set: number; newcomers: string[] };
