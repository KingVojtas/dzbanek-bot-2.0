import type { Guild, GuildMember } from 'discord.js';
import type { Logger } from '../core/logger';
import type { PlayerStation, StationIntro, Track } from '../core/types';
import { zonedParts } from '../kitchen/time';
import type { CompositeTrackSource } from '../music/sources';
import { getStation } from '../radio/station';
import type { DjVoice } from './voice';
import type { DjWriter } from './writer';
import {
  CRATE_SIZE,
  MAX_SONG_SEC,
  SET_MIN,
  isSameSong,
  pickSong,
  relativeDay,
  sampleCrate,
  templateOpener,
  themeName,
  themedSet,
  type DjLanguage,
  type FmSong,
  type OpenerSong,
  type PlannedSong,
  type Theme,
} from './script';

/** A set still waiting behind requests after this long is planned again: its line names the time. */
const STALE_MS = 20 * 60_000;
/** Tries to top up a set whose songs would not load. */
const FILL_TRIES = 4;
/** What Claude hears of this show: its last vibes and songs. */
const VIBES_SHOWN = 6;
const PLAYED_SHOWN = 30;
/** Shown under "Brought in by" for a song nobody in the kitchen brought. */
const NEW_FIND = '🎙️ Kitchen FM · new find';

export interface FmStationDeps {
  guild: Guild;
  /** People (not bots) in the bot's voice channel right now. */
  listeners: () => GuildMember[];
  /** The kitchen's songs, read fresh for every set. */
  pool: () => Promise<FmSong[]>;
  source: CompositeTrackSource;
  writer: DjWriter;
  voice: DjVoice;
  language: DjLanguage;
  /** New finds a set may hold, songs the kitchen never played. */
  discover: number;
  timezone: string;
  logger: Logger;
}

/** A few songs that share a vibe. The DJ talks before the first one only. */
interface FmSet {
  vibe: string;
  line: string;
  tracks: Track[];
  /** The next of `tracks` to hand out. */
  next: number;
  plannedAt: number;
}

type SetBase = { hour: number; minute: number; set: number; newcomers: string[] };

/**
 * Kitchen FM in one server, in the style of Spotify's DJ. When the queue runs
 * dry it plays sets of a few songs with one vibe, and the DJ talks once per
 * set: the time, the vibe, the first song, and who brought it in.
 */
export class FmStation implements PlayerStation {
  private current: FmSet | null = null;
  private pending: FmSet | null = null;
  private peeking: Promise<Track | null> | null = null;
  private readonly recent: string[] = [];
  private readonly vibes: string[] = [];
  /** "Artist – Title" of every song this show put on, so a new find is not suggested twice. */
  private readonly played: string[] = [];
  private readonly setOf = new WeakMap<Track, FmSet>();
  private readonly about = new WeakMap<Track, OpenerSong>();
  private readonly intros = new WeakMap<FmSet, Promise<StationIntro | null>>();
  private lastTheme: Theme['kind'] | undefined;
  /** Who was listening when the current set started. */
  private heard = new Set<string>();
  private ended = false;

  constructor(
    private readonly deps: FmStationDeps,
    private readonly onEnd: () => void,
  ) {}

  upNext(): Promise<Track | null> {
    if (this.ended) return Promise.resolve(null);
    if (this.pending && Date.now() - this.pending.plannedAt > STALE_MS) {
      this.pending = null;
      this.peeking = null;
    }
    this.peeking ??= this.peek().then(
      (track) => {
        // Nobody listening, or nothing playable: ask again next time.
        if (!track) this.peeking = null;
        return track;
      },
      (error: unknown) => {
        this.deps.logger.warn('Kitchen FM could not plan a set:', error);
        this.peeking = null;
        return null;
      },
    );
    return this.peeking;
  }

  queued(): Track | null {
    const current = this.current;
    if (current && current.next < current.tracks.length) return current.tracks[current.next]!;
    return this.pending?.tracks[0] ?? null;
  }

  starting(track: Track): void {
    const set = this.setOf.get(track);
    if (!set) return;
    if (set === this.pending && set.tracks[0] === track) {
      this.pending = null;
      this.current = set;
      this.vibes.push(set.vibe);
      this.heard = new Set(this.deps.listeners().map((member) => member.id));
    }
    // Requests and replays leave the set where it was.
    if (set !== this.current || set.tracks[set.next] !== track) return;
    set.next += 1;
    this.peeking = null;
  }

  intro(track: Track): Promise<StationIntro | null> {
    if (this.ended) return Promise.resolve(null);
    const set = this.setOf.get(track);
    // The DJ talks once a set, before its first song.
    if (!set || set.tracks[0] !== track) return Promise.resolve(null);
    let pending = this.intros.get(set);
    if (!pending) {
      pending = this.deps.voice
        .speak(set.line)
        .then((audio) => ({ text: set.line, audio }))
        .catch((error: unknown) => {
          this.deps.logger.warn('Kitchen FM intro failed:', error);
          return { text: set.line, audio: null };
        });
      this.intros.set(set, pending);
    }
    return pending;
  }

  vibeOf(track: Track): string | null {
    return this.setOf.get(track)?.vibe ?? null;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
  }

  private async peek(): Promise<Track | null> {
    const queued = this.queued();
    if (queued) return queued;
    this.pending = await this.plan();
    return this.pending?.tracks[0] ?? null;
  }

  /** The next set: Claude's when it can, else one the station puts together itself. */
  private async plan(): Promise<FmSet | null> {
    const listeners = this.deps.listeners();
    if (listeners.length === 0) {
      this.deps.logger.info(`Kitchen FM in ${this.deps.guild.name}: nobody is listening.`);
      return null;
    }
    const pool = (await this.deps.pool()).filter((song) => song.durationSec <= MAX_SONG_SEC);
    const clock = zonedParts(this.deps.timezone);
    const number = this.vibes.length + 1;
    const base: SetBase = {
      hour: clock.hour,
      minute: clock.minute,
      set: number,
      newcomers:
        number > 1
          ? listeners
              .filter((member) => !this.heard.has(member.id))
              .map((member) => member.displayName)
          : [],
    };
    const time = `${clock.weekday} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;

    const set =
      (await this.planWithClaude(pool, base, time, listeners)) ??
      (await this.planThemed(pool, base, listeners));
    if (!set || this.ended) return null;
    for (const track of set.tracks) {
      this.setOf.set(track, set);
      const song = this.about.get(track);
      if (song) this.played.push(song.artist ? `${song.artist} – ${song.title}` : song.title);
    }
    if (this.played.length > 200) this.played.splice(0, this.played.length - 200);
    const finds = set.tracks.filter((track) => this.about.get(track)?.how === 'new').length;
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: set ${number}, "${set.vibe}", ` +
        `${set.tracks.length} songs${finds ? ` (${finds} new)` : ''}: "${set.line}"`,
    );
    return set;
  }

  private async planWithClaude(
    pool: FmSong[],
    base: SetBase,
    time: string,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    if (!this.deps.writer.ready) return null;
    const crateSongs = sampleCrate(pool, this.recent, CRATE_SIZE);
    const names = await this.namesOf(crateSongs);
    const plan = await this.deps.writer.planSet({
      language: this.deps.language,
      server: this.deps.guild.name,
      time,
      ...base,
      earlierVibes: this.vibes.slice(-VIBES_SHOWN),
      playedThisShow: this.played.slice(-PLAYED_SHOWN),
      listeners: listeners.map((member) => member.displayName),
      discover: this.deps.discover,
      crate: crateSongs.map((song, i) => ({
        n: i + 1,
        artist: song.artist,
        title: song.title,
        by: names.get(song.from.userId ?? '') ?? null,
        how: song.from.kind === 'catch' ? 'catch' : 'play',
        when: relativeDay(song.at),
        station: song.stationId ? (getStation(song.stationId)?.name ?? null) : null,
      })),
    });
    if (!plan) return null;

    const loaded = await Promise.all(
      plan.songs.map((song) =>
        this.loadPlanned(song, crateSongs, pool).catch((error: unknown) => {
          this.deps.logger.warn(`Kitchen FM could not load "${song.title}":`, error);
          return null;
        }),
      ),
    );
    // A new find can turn out to be a kitchen song already in the set.
    const tracks = loaded.filter(
      (track, i): track is Track =>
        track !== null && loaded.findIndex((other) => other?.url === track.url) === i,
    );
    await this.fill(tracks, pool);
    if (tracks.length === 0) return null;
    const line = loaded[0] && plan.line ? plan.line : this.opener(base, plan.vibe, tracks[0]!);
    return { vibe: plan.vibe, line, tracks, next: 0, plannedAt: Date.now() };
  }

  private async planThemed(
    pool: FmSong[],
    base: SetBase,
    listeners: GuildMember[],
  ): Promise<FmSet | null> {
    const picked = themedSet(pool, this.recent, {
      listeners: new Map(listeners.map((member) => [member.id, member.displayName])),
      last: this.lastTheme,
    });
    if (!picked) return null;
    const loaded = await Promise.all(picked.songs.map((song) => this.loadSong(song)));
    const tracks = loaded.filter((track): track is Track => track !== null);
    await this.fill(tracks, pool);
    if (tracks.length === 0) return null;
    this.lastTheme = picked.theme.kind;
    return {
      vibe: themeName(picked.theme, this.deps.language),
      line: this.opener(base, picked.theme, tracks[0]!),
      tracks,
      next: 0,
      plannedAt: Date.now(),
    };
  }

  private opener(base: SetBase, vibe: string | Theme, first: Track): string {
    return templateOpener({
      language: this.deps.language,
      server: this.deps.guild.name,
      ...base,
      vibe,
      first: this.about.get(first) ?? { artist: '', title: first.title, by: null, how: 'play' },
    });
  }

  /** A crate song by its number, a kitchen song Claude named, or a new find off YouTube. */
  private async loadPlanned(
    song: PlannedSong,
    crate: FmSong[],
    pool: FmSong[],
  ): Promise<Track | null> {
    if (song.crate !== null) {
      const kitchen = crate[song.crate - 1];
      return kitchen ? this.loadSong(kitchen) : null;
    }
    const known = pool.find((kitchen) => isSameSong(song, { title: kitchen.label }));
    if (known) return this.loadSong(known);
    if (this.played.some((label) => isSameSong(song, { title: label }))) return null;

    const query = song.artist ? `${song.artist} - ${song.title}` : song.title;
    const hit = await this.deps.source.youtube.searchOne(query, NEW_FIND);
    if (!hit || hit.durationSec > MAX_SONG_SEC || !isSameSong(song, hit)) {
      this.deps.logger.info(`Kitchen FM: no YouTube match for the new find "${query}".`);
      return null;
    }
    hit.stationPick = true;
    this.about.set(hit, { artist: song.artist, title: song.title, by: null, how: 'new' });
    return hit;
  }

  /** Top a short set up with random kitchen songs. */
  private async fill(tracks: Track[], pool: FmSong[]): Promise<void> {
    for (let tries = 0; tracks.length < SET_MIN && tries < FILL_TRIES; tries += 1) {
      const song = pickSong(pool, this.recent);
      if (!song) return;
      const track = await this.loadSong(song);
      if (track && !tracks.some((other) => other.url === track.url)) tracks.push(track);
    }
  }

  /** A played song plays from its link; a catch is looked up on YouTube first. */
  private async loadSong(song: FmSong): Promise<Track | null> {
    this.recent.push(song.key);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    const userId = song.from.userId;
    const by = userId ? await this.nameOf(userId) : null;
    const about: OpenerSong = {
      artist: song.artist,
      title: song.title,
      by,
      how: song.from.kind === 'catch' ? 'catch' : 'play',
    };
    if (song.url) {
      const track: Track = {
        title: song.videoTitle ?? song.label,
        url: song.url,
        durationSec: song.durationSec,
        thumbnail: song.thumbnail,
        uploader: song.uploader,
        requestedBy: by ?? 'Kitchen FM',
        requestedById: userId,
        source: 'youtube',
        stationPick: true,
      };
      this.about.set(track, about);
      return track;
    }
    const hit = await this.deps.source.youtube
      .searchOne(song.query, by ?? 'Kitchen FM')
      .catch((error: unknown) => {
        this.deps.logger.warn(`Kitchen FM could not look up "${song.label}":`, error);
        return null;
      });
    if (!hit || hit.durationSec > MAX_SONG_SEC) return null;
    hit.requestedById = userId;
    hit.stationPick = true;
    hit.thumbnail ??= song.thumbnail;
    this.about.set(hit, about);
    return hit;
  }

  /** Display names of who brought each song, by user id. */
  private async namesOf(songs: FmSong[]): Promise<Map<string, string>> {
    const ids = [...new Set(songs.flatMap((song) => (song.from.userId ? [song.from.userId] : [])))];
    const names = await Promise.all(ids.map((id) => this.nameOf(id)));
    return new Map(ids.flatMap((id, i) => (names[i] ? [[id, names[i]]] : [])));
  }

  private async nameOf(userId: string): Promise<string | null> {
    const member =
      this.deps.guild.members.cache.get(userId) ??
      (await this.deps.guild.members.fetch(userId).catch(() => null));
    return member?.displayName ?? null;
  }
}
