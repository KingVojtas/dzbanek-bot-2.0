import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { Readable } from 'node:stream';
import type { Config } from '../config';
import type { Logger } from './logger';
import type { GuildSettingsStore } from '../deals/guild-settings';
import type { WishlistRadar } from '../deals/steam/WishlistRadar';
import type { SteamLinkStore } from '../deals/steam/steam-links';
import type { KitchenFm } from '../fm/KitchenFm';
import type { KitchenBoard } from '../kitchen/KitchenBoard';
import type { MusicManager } from '../music/MusicManager';
import type { QuizManager } from '../quiz/QuizManager';
import type { RadioManager } from '../radio/RadioManager';

/** Shared services injected into every command's `execute`. */
export interface Services {
  config: Config;
  logger: Logger;
  music: MusicManager;
  radio: RadioManager;
  guildSettings: GuildSettingsStore;
  kitchen: KitchenBoard;
  steamLinks: SteamLinkStore;
  wishlistRadar: WishlistRadar;
  quiz: QuizManager;
  fm: KitchenFm;
}

/** Loop modes for music queue. */
export type LoopMode = 'off' | 'track' | 'queue';

/** A slash command: its definition plus its handler. */
export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction, services: Services): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, services: Services): Promise<void>;
}

/** A single playable item in the music queue. */
export interface Track {
  title: string;
  /**
   * Streamable media URL (YouTube watch URL).
   * Spotify tracks use a YouTube URL for audio; see `sourceUrl` for the Spotify page.
   */
  url: string;
  durationSec: number;
  thumbnail?: string;
  requestedBy: string;
  requestedById?: string;
  uploader?: string;
  views?: number;
  uploadedAt?: string;
  source?: 'youtube' | 'spotify' | 'other';
  /**
   * Original platform page when `url` is a different host used for streaming
   * (e.g. Spotify open.spotify.com link while audio is pulled from YouTube).
   */
  sourceUrl?: string;
  /**
   * Picked by Kitchen FM, not asked for. `requestedById` is who brought the song
   * in, and the played-songs list leaves it out so its date and story stay true.
   */
  stationPick?: boolean;
}

/** What the DJ says before a set: the words, and the clip when the voice worked. */
export interface StationIntro {
  text: string;
  /** PCM s16le, 48 kHz, stereo. Null plays no clip; the words still show on the card. */
  pcm: Buffer | null;
}

/**
 * A station on the music player (Kitchen FM): it plays sets of songs whenever
 * the queue runs dry, and the DJ talks before each set.
 */
export interface PlayerStation {
  /** The song after the queue, picked ahead of time. Null ends the show. */
  upNext(): Promise<Track | null>;
  /** The song `upNext` would give now, when it is already known. */
  queued(): Track | null;
  /** The player is about to play `track`, a request or the station's pick. */
  starting(track: Track): void;
  /** `track` did not start: the stream failed, not a skip, stop, or a newer song. */
  missed?(track: Track): void;
  /** The DJ read the intro for `track`. A later `missed` leaves its dedication where it is. */
  spoke?(track: Track): void;
  /**
   * A song already playing when the station goes on air. It counts as just
   * played, the same as `starting`, so the next set does not open with it.
   */
  heard?(track: Track): void;
  /** What the DJ says before `track`, if anything. Asked early to prepare it, then again to play it. */
  intro(track: Track): Promise<StationIntro | null>;
  /**
   * How long the player may wait for this intro. The show's first line is
   * synthesized cold and may take longer. Omitted means the usual wait.
   */
  introWaitMs?(track: Track): number | undefined;
  /**
   * The whole audio of `track`, downloaded before the show, so the first song
   * starts without waiting for YouTube. Handed over once; null after that.
   */
  preloadedAudio?(track: Track): Buffer | null;
  /** The vibe of the set `track` belongs to, for the card. */
  vibeOf(track: Track): string | null;
  /** The player left voice, or the station was switched off. */
  end(): void;
}

/**
 * Turns user input into tracks and opens an audio stream.
 * Swap the YouTube backend without touching the rest of the bot.
 */
export interface TrackSource {
  resolve(input: string, requestedBy: string): Promise<Track[]>;
  stream(track: Track): Promise<Readable>;
}

/** A free game from the Epic Games Store weekly promotion. */
export interface EpicFreeGame {
  title: string;
  description: string;
  originalPrice: string;
  storeUrl: string;
  /** Tall/square box art for the row thumbnail. */
  image?: string;
  /** Wide store banner — used as the digest hero image. */
  heroImage?: string;
  seller?: string;
  endDate?: string;
  isUpcoming: boolean;
  upcomingStartDate?: string;
}

/** A normalized Steam deal from the game-deals.app RSS feed. */
export interface SteamDealItem {
  id: string;
  title: string;
  gameName: string;
  link: string;
  salePrice?: string;
  originalPrice?: string;
  discount?: string;
  expires?: string;
  publisher?: string;
  igdbRating?: string;
  metascore?: string;
  dealScore?: string;
  genres?: string;
  description?: string;
  /** Major-studio or full-priced blockbuster. The daily card prefers these. */
  blockbuster?: boolean;
  /** Thumbnail that Discord can fetch. A portrait capsule when Steam has one. */
  image?: string;
  /** Wide banner for the top deal. */
  heroImage?: string;
  /** Store release date as Steam prints it, e.g. "5 Dec, 2019". */
  released?: string;
  /** Steam store tag ids, most relevant first. */
  tagIds?: number[];
  /** Up to four tag or genre names for the digest row. */
  tags?: string;
  isoDate?: string;
}
