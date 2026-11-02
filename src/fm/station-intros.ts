import type { Logger } from '../core/logger';
import type { StationIntro, Track } from '../core/types';
import { DedicationQueue, joinClips, joinIntro, type WaitingDedication } from './dedications';
import type { GenreId } from './genres';
import { JINGLE_GAP_MS, namedJingle, playNewFindJingle, type JingleLibrary } from './jingles';
import {
  joinNames,
  lineDaypart,
  lineTime,
  loadLineBook,
  momentsFor,
  songPhrase,
  type LineBook,
  type LineSlots,
  type Moment,
} from './lines';
import { templateOpener, type DjLanguage, type OpenerSong } from './script';
import type { FmSet, SetBase } from './station-types';
import type { DjSpeaker } from './voice';

/** What the spoken lines read off the station. The show still decides when a song starts. */
export interface StationIntroDeps {
  guildName: string;
  language: DjLanguage;
  voice: DjSpeaker;
  /** Sung jingles. A missing file leaves the spoken line on its own. */
  jingles?: JingleLibrary | null;
  logger: Logger;
  /**
   * The DJ's line book. Loaded for `language` when omitted.
   * `null` means there is no book, so the built-in line is used.
   */
  lines?: LineBook | null;
  ended: () => boolean;
  setOf: (track: Track) => FmSet | undefined;
  about: (track: Track) => OpenerSong | undefined;
  dedications: DedicationQueue;
  /** Handed over in `starting`, so an early `intro` cannot spend it. */
  dedicationOf: WeakMap<Track, WaitingDedication>;
}

/**
 * The lines between songs: set intros, the new-find jingle, and dedications
 * joined onto a line. The station still owns which dedication belongs to which
 * song, and when the player asks for the clip.
 */
export class StationIntros {
  /** Set lines in flight or ready. A clip that came back empty is dropped. */
  private readonly intros = new WeakMap<FmSet, Promise<StationIntro | null>>();
  /** Dedication clips in flight or ready. A clip that came back empty is dropped. */
  readonly dedicationClips = new WeakMap<WaitingDedication, Promise<Buffer | null>>();
  /** Joined intro. Dropped when a part that should have audio came back empty. */
  readonly combined = new WeakMap<Track, Promise<StationIntro | null>>();
  /** The rotation block that already played its new-find jingle. */
  private newFindJingleGenre: GenreId | null = null;
  /** Line indexes already said this show, so a line is not repeated while others remain. */
  private readonly usedLines = new Map<Moment, Set<number>>();
  readonly lineBook: LineBook | null;

  constructor(private readonly deps: StationIntroDeps) {
    this.lineBook = deps.lines === undefined ? loadLineBook(deps.language) : deps.lines;
  }

  /** Bind the dedication this song should read. An early `intro` has not called this. */
  handDedication(track: Track): void {
    if (this.deps.ended() || this.deps.dedicationOf.has(track)) return;
    const dedication = this.deps.dedications.take(track);
    if (dedication) this.deps.dedicationOf.set(track, dedication);
  }

  /**
   * The set line for the first song of a set. Null for any other song.
   * Callers that ask together share one synthesis. A clip that came back
   * empty is forgotten, so the next `intro` tries again before the song.
   */
  setIntro(track: Track): Promise<StationIntro | null> | null {
    const set = this.deps.setOf(track);
    if (!set || set.tracks[0] !== track) return null;
    if (set.breakClip) {
      const pending = this.intros.get(set);
      if (pending) return pending;
      this.intros.set(set, set.breakClip);
      return set.breakClip;
    }
    const pending = this.intros.get(set);
    if (pending) return pending;
    const next = this.speakSetLine(set);
    this.intros.set(set, next);
    return next;
  }

  /**
   * The set line, with a station ID in front of the opener and a new-find
   * jingle in front of a later set. The file is decoded beside the voice,
   * and a failed decode leaves the line on its own.
   */
  private speakSetLine(set: FmSet): Promise<StationIntro | null> {
    const lead = this.stationLead(set);
    if (set.preparedClip?.length) {
      const pcm = set.preparedClip;
      return lead.then((jingle) => this.withLead(set, { text: set.line, pcm }, jingle));
    }
    return Promise.all([this.deps.voice.speak(set.line), lead])
      .then(([pcm, jingle]) => {
        if (!pcm?.length) {
          this.intros.delete(set);
          return { text: set.line, pcm: null };
        }
        return this.withLead(set, { text: set.line, pcm }, jingle);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM intro failed:', error);
        this.intros.delete(set);
        return { text: set.line, pcm: null };
      });
  }

  /**
   * `new-find` once in a later set of the block. The opener's line has no
   * jingle of its own: the opening jingle already played when the radio was
   * switched on.
   */
  private stationLead(set: FmSet): Promise<Buffer | null> {
    const lib = this.deps.jingles;
    if (!lib) return Promise.resolve(null);
    return this.loadLead(set, lib).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM jingle failed:', error);
      return null;
    });
  }

  private async loadLead(set: FmSet, lib: JingleLibrary): Promise<Buffer | null> {
    if (set.opener) return null;
    const first = set.tracks[0];
    const how = (first && this.deps.about(first)?.how) || 'play';
    if (
      !playNewFindJingle({
        how,
        opener: Boolean(set.opener),
        blockStart: Boolean(set.blockStart),
        played: this.newFindJingleGenre !== null && this.newFindJingleGenre === set.rotationGenre,
        rotation: Boolean(set.rotationGenre),
      })
    ) {
      return null;
    }
    const pcm = await lib.clip(namedJingle(lib.files(), 'new-find'));
    if (!pcm?.length) return null;
    return pcm;
  }

  /** The jingle, half a second of quiet, then the line. The card text stays the line. */
  private withLead(set: FmSet, intro: StationIntro, lead: Buffer | null): StationIntro {
    if (!intro.pcm?.length || !lead?.length) return { text: intro.text, pcm: intro.pcm };
    if (!set.opener && set.rotationGenre) this.newFindJingleGenre = set.rotationGenre;
    return { text: intro.text, pcm: joinClips([lead, intro.pcm], JINGLE_GAP_MS) };
  }

  /**
   * The dedication clip. A failure is dropped, so the next `intro` tries
   * again instead of replaying the empty buffer. Two callers share one call.
   */
  speakDedication(dedication: WaitingDedication): Promise<Buffer | null> {
    const cached = this.dedicationClips.get(dedication);
    if (cached) return cached;
    const pending = this.deps.voice
      .speak(dedication.text)
      .then((pcm) => {
        if (!pcm?.length) this.dedicationClips.delete(dedication);
        return pcm;
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM dedication failed:', error);
        this.dedicationClips.delete(dedication);
        return null;
      });
    this.dedicationClips.set(dedication, pending);
    dedication.speech = pending;
    return pending;
  }

  /** Dedication first, a short gap, then the set line. The card shows both texts. */
  async withDedication(
    track: Track,
    dedication: WaitingDedication,
    setLine: Promise<StationIntro | null> | null,
  ): Promise<StationIntro> {
    const [spoken, set] = await Promise.all([
      this.speakDedication(dedication),
      setLine ?? Promise.resolve(null),
    ]);
    const jingle = spoken?.length ? await this.dedicationClip() : null;
    const text = [dedication.text, set?.text].filter(Boolean).join(' ');
    const pcm = joinIntro(spoken, set?.pcm ?? null, jingle);
    // A missing part is not final: the next intro tries that part again.
    if (!spoken?.length || (setLine && !set?.pcm?.length)) this.combined.delete(track);
    return { text, pcm };
  }

  /** `dedication.mp3` ahead of the spoken message. Null when the file is missing. */
  private dedicationClip(): Promise<Buffer | null> {
    const lib = this.deps.jingles;
    if (!lib) return Promise.resolve(null);
    return lib.clip(namedJingle(lib.files(), 'dedication')).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM jingle failed:', error);
      return null;
    });
  }

  /** The line book, then the short built-in line when the book has nothing. */
  speak(base: SetBase, vibe: string, first: Track, newBlock: boolean): string {
    const about = this.deps.about(first) ?? {
      artist: '',
      title: first.title,
      by: null,
      how: 'play' as const,
    };
    const line = this.lineBook?.speak(
      momentsFor({
        set: base.set,
        newBlock,
        hour: base.hour,
        newcomers: base.newcomers,
        how: about.how,
        by: about.by,
      }),
      this.slots(base, vibe, about),
      this.usedLines,
    );
    if (line) return line;
    return templateOpener({
      language: this.deps.language,
      server: this.deps.guildName,
      ...base,
      vibe,
      first: about,
    });
  }

  slots(base: SetBase, genre: string, song: OpenerSong): LineSlots {
    const language = this.deps.language;
    return {
      server: this.deps.guildName,
      time: lineTime(base.hour, base.minute, language),
      daypart: lineDaypart(base.hour, language),
      genre,
      song: songPhrase(song.artist, song.title, language),
      artist: song.artist,
      by: song.by ?? '',
      names: joinNames(base.newcomers, language),
      station: 'Kitchen FM',
      from: '',
      to: '',
      message: '',
    };
  }
}
