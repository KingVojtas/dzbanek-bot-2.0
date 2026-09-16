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
import type { MusicManager } from '../music/MusicManager';

/** Shared services injected into every command's `execute`. */
export interface Services {
  config: Config;
  logger: Logger;
  music: MusicManager;
  guildSettings: GuildSettingsStore;
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
  image?: string;
  isoDate?: string;
}
