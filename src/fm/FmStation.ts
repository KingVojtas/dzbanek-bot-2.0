import type { Guild, GuildMember } from 'discord.js';
import type { Logger } from '../core/logger';
import type { PlayerStation, StationIntro, Track } from '../core/types';
import { zonedParts } from '../kitchen/time';
import type { CompositeTrackSource } from '../music/sources';
import { songFromTrack } from '../quiz/songs';
import { getStation } from '../radio/station';
import type { DjVoice } from './voice';
import type { DjWriter } from './writer';
import {
  MAX_SONG_SEC,
  cleanLine,
  pickSong,
  relativeDay,
  templateLine,
  type DjFacts,
  type DjLanguage,
  type FmSong,
} from './script';

/** Tries per pick before the show gives up (a catch with no YouTube match, a dead link). */
const PICK_TRIES = 3;
/** Intros kept ready: the next song, and one spare for a queue that just changed. */
const INTRO_CACHE = 3;

export interface FmStationDeps {
  guild: Guild;
  /** People (not bots) in the bot's voice channel right now. */
  listeners: () => GuildMember[];
  /** The kitchen's songs, read fresh for every pick. */
  pool: () => Promise<FmSong[]>;
  source: CompositeTrackSource;
  writer: DjWriter;
  voice: DjVoice;
  language: DjLanguage;
  timezone: string;
  logger: Logger;
}

/**
 * Kitchen FM in one server. When the queue runs dry it plays a kitchen song,
 * and before every song the DJ says a line about it: who brought it, when,
 * and who just walked in.
 */
export class FmStation implements PlayerStation {
  private picking: Promise<Track | null> | null = null;
  private picked: Track | null = null;
  private readonly recent: string[] = [];
  /** The kitchen song behind each pick, for the DJ's facts. */
  private readonly songs = new WeakMap<Track, FmSong>();
  private readonly intros = new Map<string, Promise<StationIntro | null>>();
  /** Who was listening when the last song started, and when the one before it did. */
  private heard = new Set<string>();
  private heardBefore = new Set<string>();
  /** Songs started so far; `startingTrack` is the latest. */
  private songNumber = 0;
  private startingTrack: Track | null = null;
  private ended = false;

  constructor(
    private readonly deps: FmStationDeps,
    private readonly onEnd: () => void,
  ) {}

  upNext(): Promise<Track | null> {
    if (this.ended) return Promise.resolve(null);
    this.picking ??= this.pick().then(
      (track) => {
        this.picked = track;
        // Nobody listening, or nothing playable: ask again next time.
        if (!track) this.picking = null;
        return track;
      },
      (error: unknown) => {
        this.deps.logger.warn('Kitchen FM could not pick a song:', error);
        this.picking = null;
        return null;
      },
    );
    return this.picking;
  }

  starting(track: Track): void {
    this.songNumber += 1;
    this.startingTrack = track;
    this.heardBefore = this.heard;
    this.heard = new Set(this.deps.listeners().map((member) => member.id));
    if (track === this.picked) {
      this.picked = null;
      this.picking = null;
    }
  }

  intro(track: Track, previous: Track | null): Promise<StationIntro | null> {
    if (this.ended) return Promise.resolve(null);
    const key = `${previous?.url ?? ''} > ${track.url}`;
    let pending = this.intros.get(key);
    if (!pending) {
      pending = this.writeIntro(track, previous).catch((error: unknown) => {
        this.deps.logger.warn('Kitchen FM intro failed:', error);
        return null;
      });
      this.intros.set(key, pending);
      for (const old of this.intros.keys()) {
        if (this.intros.size <= INTRO_CACHE) break;
        this.intros.delete(old);
      }
    }
    return pending;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.intros.clear();
    this.onEnd();
  }

  private async pick(): Promise<Track | null> {
    if (this.deps.listeners().length === 0) {
      this.deps.logger.info(`Kitchen FM in ${this.deps.guild.name}: nobody is listening.`);
      return null;
    }
    const pool = await this.deps.pool();
    for (let attempt = 0; attempt < PICK_TRIES; attempt += 1) {
      const song = pickSong(pool, this.recent);
      if (!song) return null;
      this.recent.push(song.key);
      if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
      const track = await this.toTrack(song).catch((error: unknown) => {
        this.deps.logger.warn(`Kitchen FM could not load "${song.label}":`, error);
        return null;
      });
      if (track) {
        this.songs.set(track, song);
        return track;
      }
    }
    return null;
  }

  /** A played song plays from its link; a catch is looked up on YouTube first. */
  private async toTrack(song: FmSong): Promise<Track | null> {
    const userId = song.from.userId;
    const requestedBy = (userId && (await this.nameOf(userId))) || 'Kitchen FM';
    if (song.url) {
      return {
        title: song.videoTitle ?? song.label,
        url: song.url,
        durationSec: song.durationSec,
        thumbnail: song.thumbnail,
        uploader: song.uploader,
        requestedBy,
        requestedById: userId,
        source: 'youtube',
        stationPick: true,
      };
    }
    const hit = await this.deps.source.youtube.searchOne(song.query, requestedBy);
    if (!hit || hit.durationSec > MAX_SONG_SEC) return null;
    hit.requestedById = userId;
    hit.stationPick = true;
    hit.thumbnail ??= song.thumbnail;
    return hit;
  }

  private async writeIntro(track: Track, previous: Track | null): Promise<StationIntro | null> {
    const facts = await this.facts(track, previous);
    if (!facts) return null;
    const written = cleanLine((await this.deps.writer.write(facts)) ?? '');
    const text = written || templateLine(facts);
    const audio = await this.deps.voice.speak(text);
    this.deps.logger.info(
      `Kitchen FM in ${this.deps.guild.name}: "${text}"${audio ? '' : ' (text only)'}`,
    );
    return { text, audio };
  }

  /** What the DJ knows before `track`. Null when nobody is there to hear it. */
  private async facts(track: Track, previous: Track | null): Promise<DjFacts | null> {
    const listeners = this.deps.listeners();
    if (listeners.length === 0) return null;
    const song = this.songs.get(track);
    const parsed = song ?? songFromTrack(track, { kind: 'play' });
    const by = song?.from.userId
      ? await this.nameOf(song.from.userId)
      : track.requestedById
        ? ((await this.nameOf(track.requestedById)) ?? track.requestedBy)
        : null;
    const last = previous ? songFromTrack(previous, { kind: 'play' }) : null;
    const clock = zonedParts(this.deps.timezone);
    // Usually written ahead, during the song before. Written late, the song has already started.
    const late = track === this.startingTrack;
    const songNumber = late ? this.songNumber : this.songNumber + 1;
    const heard = late ? this.heardBefore : this.heard;
    return {
      language: this.deps.language,
      server: this.deps.guild.name,
      time: `${clock.weekday} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
      hour: clock.hour,
      songNumber,
      previous: last ? { artist: last.artist, title: last.title } : null,
      next: {
        artist: parsed.artist,
        title: parsed.title,
        by,
        how: song ? (song.from.kind === 'catch' ? 'catch' : 'play') : 'request',
        when: song ? relativeDay(song.at) : null,
        station: song?.stationId ? (getStation(song.stationId)?.name ?? null) : null,
      },
      listeners: listeners.map((member) => member.displayName),
      newcomers:
        songNumber > 1
          ? listeners.filter((member) => !heard.has(member.id)).map((member) => member.displayName)
          : [],
    };
  }

  private async nameOf(userId: string): Promise<string | null> {
    const member =
      this.deps.guild.members.cache.get(userId) ??
      (await this.deps.guild.members.fetch(userId).catch(() => null));
    return member?.displayName ?? null;
  }
}
