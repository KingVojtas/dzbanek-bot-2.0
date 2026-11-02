import type { Logger } from '../core/logger';
import type { StationIntro, Track } from '../core/types';
import { pcmSeconds } from '../music/intro-wait';
import {
  BREAK_SPEAK_MS,
  BREAK_TAIL_SEC,
  applyBedAsync,
  breakTailReserve,
  emptyBreak,
  joinBreak,
  renderBreakHead,
  renderBreakTail,
  type BreakClip,
  type BreakFiles,
  type BreakUsed,
  type BreakVoices,
} from './break-show';
import { loadBreakBook, type BreakBook } from './breaks';
import type { GenreId } from './genres';
import { genreName } from './genres';
import {
  GENRE_JINGLE_RESERVE_SEC,
  genreJingle,
  namedJingle,
  pickJingle,
  type JingleLibrary,
  type JingleUsed,
} from './jingles';
import { joinNames, songPhrase } from './lines';
import type { RotationCursor } from './rotation';
import type { DjLanguage, OpenerSong } from './script';
import type { FmSet, SetBase } from './station-types';
import type { DjSpeaker } from './voice';

/** Once the player is waiting, a break whose tail is still missing goes out with its head. */
const BREAK_DEADLINE_MS = 45_000;

/** Station songs in one rotation block, clamped to 5–30. */
export function blockSongCount(count: number | undefined): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 15;
  return Math.min(30, Math.max(5, Math.round(count)));
}

/** Break length in seconds, clamped to 0–300. 0 means the usual block line. */
export function breakLength(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 180;
  return Math.min(300, Math.max(0, Math.round(seconds)));
}

/** What the break reads off the station. The show still owns when a block ends. */
export interface StationBreakDeps {
  guildName: string;
  language: DjLanguage;
  voice: DjSpeaker;
  /** Station IDs, promos, and outros. Separate from `voice`, so a miss does not rest the DJ. */
  jingle?: DjSpeaker;
  /** Sung jingles. A missing file falls back to the chime and the Edge voice. */
  jingles?: JingleLibrary | null;
  blockSongs?: number;
  breakSeconds?: number;
  logger: Logger;
  /** Genre the previous show on this server ended on. Updated when this show ends. */
  rotationCursor?: RotationCursor;
  /** Finding the next show's first song, not playing this one. */
  preparingOpener: () => boolean;
  ended: () => boolean;
  /** The rotation block on air. Null before the first one. */
  rotation: () => { genre: GenreId; artists: readonly string[] } | null;
  about: (track: Track) => OpenerSong | undefined;
  /** The usual new-block line, when the break itself has no voice. */
  speak: (base: SetBase, vibe: string, first: Track, newBlock: boolean) => string;
}

/**
 * The break between rotation blocks, and the jingle files already played this
 * show. The opening jingle reads `jingleUsed` so a file is not picked twice.
 */
export class StationBreaks {
  /** Steps 1–3 of the break after this block. Started once the block's songs are known. */
  breakHead: Promise<BreakClip> | null = null;
  /** Promos and station IDs already said this show. */
  private readonly breakUsed: BreakUsed = { ids: new Set(), promos: new Set() };
  /** Jingle files already played this show, so the next pick is a different one. */
  readonly jingleUsed: JingleUsed = {
    ids: new Set<string>(),
    sweepers: new Set<string>(),
    beds: new Set<string>(),
  };
  private breakBookCache: BreakBook | null | undefined;

  constructor(private readonly deps: StationBreakDeps) {}

  private breakLines(): BreakBook | null {
    if (this.breakBookCache === undefined) this.breakBookCache = loadBreakBook();
    return this.breakBookCache;
  }

  /** The DJ reads the recap. Station IDs use the jingle voice, or nothing. */
  private breakVoices(): BreakVoices {
    const dj = this.deps.voice;
    const jingle = this.deps.jingle;
    return {
      dj: (text, budget) => dj.speak(text, budget),
      jingle: jingle ? (text, budget) => jingle.speak(text, budget) : async () => null,
    };
  }

  /** Steps 1–3, as soon as the block's artists are known. No-op when the break is off. */
  startBreakHead(): void {
    if (this.deps.preparingOpener() || breakLength(this.deps.breakSeconds) <= 0 || this.breakHead) {
      return;
    }
    const rotation = this.deps.rotation();
    if (!rotation) return;
    const book = this.breakLines();
    if (!book) return;
    const slots = {
      server: this.deps.guildName,
      lastGenre: genreName(rotation.genre, 'en'),
      artists: joinNames(rotation.artists.slice(0, 3), 'en'),
    };
    const files = this.breakFiles(null);
    this.breakHead = this.renderHead(book, slots, files).catch((error: unknown) => {
      this.deps.logger.warn('Kitchen FM break failed:', error);
      return emptyBreak();
    });
  }

  /** The head, leaving room for the tail's real jingle files when the folder has them. */
  private async renderHead(
    book: BreakBook,
    slots: { server: string; lastGenre: string; artists: string },
    files: BreakFiles | null,
  ): Promise<BreakClip> {
    let tail = BREAK_TAIL_SEC;
    if (files) {
      const back = await files.back().catch(() => null);
      tail = breakTailReserve(back?.length ? pcmSeconds(back) : 0, this.genreReserveSec());
    }
    return renderBreakHead(
      book,
      slots,
      this.breakVoices(),
      this.breakUsed,
      breakLength(this.deps.breakSeconds),
      Math.random,
      tail,
      files,
    );
  }

  /** A station-ID or sweeper file, marked used so the next break can pick another. */
  private pickClip(kind: 'id' | 'sweeper'): Promise<Buffer | null> {
    const lib = this.deps.jingles;
    if (!lib) return Promise.resolve(null);
    const used = kind === 'id' ? this.jingleUsed.ids : this.jingleUsed.sweepers;
    return lib.clip(pickJingle(lib.files(), kind, used, Math.random));
  }

  /** Files for one break. `genre` null means the tail does not know the next block yet. */
  private breakFiles(genre: GenreId | null): BreakFiles | null {
    const lib = this.deps.jingles;
    if (!lib) return null;
    return {
      id: () => this.pickClip('id'),
      sweeper: () => this.pickClip('sweeper'),
      back: () => lib.clip(namedJingle(lib.files(), 'back-to-music')),
      genre: () => (genre ? lib.clip(genreJingle(lib.files(), genre)) : Promise.resolve(null)),
    };
  }

  /** How long a genre jingle might be. Zero when the folder has none. */
  private genreReserveSec(): number {
    const lib = this.deps.jingles;
    if (!lib?.files().some((file) => file.kind === 'genre')) return 0;
    return GENRE_JINGLE_RESERVE_SEC;
  }

  /** The next block's first song carries the break. The card names only the genre. */
  armBreak(set: FmSet, genre: GenreId, base: SetBase): void {
    if (
      !this.breakHead ||
      breakLength(this.deps.breakSeconds) <= 0 ||
      this.deps.preparingOpener() ||
      !set.tracks[0]
    ) {
      return;
    }
    const vibe = genreName(genre, this.deps.language);
    set.line = `📻 Kitchen FM break · next up: ${genreName(genre, 'en')}`;
    set.breakClip = this.composeBreak(genre, set, base, vibe);
  }

  /**
   * Head, then the tail. Ready within a minute: a slow tail still plays the
   * head, and a break with no voice at all falls back to the block line.
   */
  private composeBreak(
    genre: GenreId,
    set: FmSet,
    base: SetBase,
    vibe: string,
  ): Promise<StationIntro | null> {
    const card = `📻 Kitchen FM break · next up: ${genreName(genre, 'en')}`;
    const head = this.breakHead ?? Promise.resolve(emptyBreak());
    this.breakHead = null;
    const book = this.breakLines();
    const tail = book
      ? renderBreakTail(
          book,
          {
            genre: genreName(genre, 'en'),
            songs: this.comingSongs(set.tracks),
            count: String(blockSongCount(this.deps.blockSongs)),
          },
          this.breakVoices(),
          Math.random,
          this.breakFiles(genre),
        ).catch((error: unknown) => {
          this.deps.logger.warn('Kitchen FM break failed:', error);
          return emptyBreak();
        })
      : Promise.resolve(emptyBreak());

    let headReady: BreakClip | null = null;
    void head.then((clip) => {
      headReady = clip;
    });

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deliver = (clip: BreakClip | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.deps.ended()) {
          resolve(null);
          return;
        }
        void this.finishBreak(clip, card, base, vibe, set).then(resolve, () =>
          resolve({ text: card, pcm: null }),
        );
      };
      // A late tail still lets the head play. The fallback block line needs a
      // few seconds of its own, so this fires before the player stops waiting.
      set.breakDue = () => {
        if (settled || timer) return;
        timer = setTimeout(() => {
          deliver(headReady?.voiced ? headReady : null);
        }, BREAK_DEADLINE_MS);
        timer.unref?.();
      };
      void Promise.all([head, tail])
        .then(([heard, next]) => deliver(joinBreak(heard, next)))
        .catch((error: unknown) => {
          this.deps.logger.warn('Kitchen FM break failed:', error);
          deliver(headReady?.voiced ? headReady : null);
        });
    });
  }

  /** The break clip, or the usual new-block line when no voice made it in. */
  private async finishBreak(
    clip: BreakClip | null,
    card: string,
    base: SetBase,
    vibe: string,
    set: FmSet,
  ): Promise<StationIntro> {
    const laid = await this.layBed(clip);
    if (laid?.voiced && laid.pcm?.length) return { text: card, pcm: laid.pcm };
    const first = set.tracks[0];
    const line = first ? this.deps.speak(base, vibe, first, true) : card;
    const pcm = await this.deps.voice.speak(line, BREAK_SPEAK_MS).catch(() => null);
    return { text: line, pcm };
  }

  /** One music bed under the whole break. A missing file leaves the voices as they are. */
  private async layBed(clip: BreakClip | null): Promise<BreakClip | null> {
    if (!clip?.pcm?.length) return clip;
    const lib = this.deps.jingles;
    if (!lib) return clip;
    try {
      const file = pickJingle(lib.files(), 'bed', this.jingleUsed.beds, Math.random);
      const bed = await lib.bed(file, Math.max(0.1, clip.seconds));
      return await applyBedAsync(clip, bed);
    } catch (error: unknown) {
      this.deps.logger.warn('Kitchen FM bed failed:', error);
      return clip;
    }
  }

  /** The next block's first songs, as "Title by Artist", up to three. */
  private comingSongs(tracks: readonly Track[]): string {
    const names = tracks.slice(0, 3).map((track) => {
      const about = this.deps.about(track);
      return songPhrase(about?.artist ?? '', about?.title || track.title, 'en');
    });
    return joinNames(names, 'en');
  }

  /** The genre this show got to, so the next one starts after it. */
  rememberRotation(): void {
    const cursor = this.deps.rotationCursor;
    if (!cursor) return;
    const rotation = this.deps.rotation();
    if (!rotation) return;
    cursor.genre = rotation.genre;
  }
}
