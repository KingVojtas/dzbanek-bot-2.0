import './env';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  discord: {
    clientId: string;
    guildId: string | null;
  };
  /** IANA timezone for Steam/Epic cron (e.g. Europe/Prague). */
  timezone: string;
  music: {
    idleTimeoutSec: number;
    maxQueueSize: number;
    /** yt-dlp `player_client` list. Null uses the built-in clients. */
    youtubeClients: string | null;
    /** Time YouTube client sets once after a passing startup check. */
    clientBenchmark: boolean;
  };
  steam: {
    channelId: string | null;
    cron: string;
    maxSeenIds: number;
    postOnFirstRun: boolean;
  };
  epic: {
    channelId: string | null;
    cron: string;
    postOnFirstRun: boolean;
  };
  /** Wishlist Radar channels, any server. Each server uses the one that belongs to it. */
  wishlist: { channelIds: string[] };
  welcome: { channelId: string | null };
  goodbye: { channelId: string | null };
  /** Kitchen FM's DJ. */
  dj: {
    language: 'en' | 'cs';
    /** A Microsoft Edge read-aloud voice, e.g. en-US-AndrewMultilingualNeural. */
    voice: string;
    /** The Claude model that plans a set only while genres are still unknown. */
    model: string;
    /** New finds per set, from related artists, 0 to 3. */
    discover: number;
    /** Sets in a genre block after the opener, from 1 to 4. The first block is one set. */
    blockSets: number;
    /** Claude-planned sets a server gets per day. Past it the station plans its own. */
    setsPerServerPerDay: number;
    /** Claude-planned sets per day across every server, a ceiling on the API bill. */
    setsPerDay: number;
  };
  embedColor: number;
}

/** The DJ's voice when config.json names none. */
const DJ_VOICES = { en: 'en-US-AndrewMultilingualNeural', cs: 'cs-CZ-VlastaNeural' } as const;

type Json = Record<string, unknown>;

const configDir = dirname(fileURLToPath(import.meta.url));

function loadRawConfig(): Json {
  try {
    return JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Json;
  } catch (error) {
    throw new Error(`Failed to read src/config/config.json: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid config: "${name}" must be a non-empty string.`);
  }
  return value;
}

/** A whole number from config, or null when it is missing or not a number. */
function wholeAtLeastZero(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'null' ? null : trimmed;
}

function parseColor(value: unknown): number {
  const text = requireString(value, 'embedColor').replace(/^#/, '');
  const color = Number.parseInt(text, 16);
  if (Number.isNaN(color)) {
    throw new Error('Invalid config: "embedColor" must be a hex color like "#5865F2".');
  }
  return color;
}

function loadConfig(): Config {
  const raw = loadRawConfig();
  const discord = (raw.discord ?? {}) as Json;
  const music = (raw.music ?? {}) as Json;
  const steam = (raw.steam ?? {}) as Json;
  const epic = (raw.epic ?? {}) as Json;
  const wishlist = (raw.wishlist ?? {}) as Json;
  const welcome = (raw.welcome ?? {}) as Json;
  const goodbye = (raw.goodbye ?? {}) as Json;
  const dj = (raw.dj ?? {}) as Json;
  const djLanguage = dj.language === 'cs' ? 'cs' : 'en';

  return {
    discord: {
      clientId: requireString(discord.clientId, 'discord.clientId'),
      guildId: optionalString(discord.guildId),
    },
    timezone: optionalString(raw.timezone) ?? 'Europe/Prague',
    music: {
      idleTimeoutSec: typeof music.idleTimeoutSec === 'number' ? music.idleTimeoutSec : 120,
      maxQueueSize: typeof music.maxQueueSize === 'number' ? music.maxQueueSize : 100,
      youtubeClients: optionalString(music.youtubeClients),
      clientBenchmark: music.clientBenchmark === true,
    },
    steam: {
      channelId: optionalString(steam.channelId),
      cron: requireString(steam.cron, 'steam.cron'),
      maxSeenIds: typeof steam.maxSeenIds === 'number' ? steam.maxSeenIds : 500,
      postOnFirstRun: Boolean(steam.postOnFirstRun),
    },
    epic: {
      channelId: optionalString(epic.channelId),
      cron: requireString(epic.cron, 'epic.cron'),
      postOnFirstRun: epic.postOnFirstRun !== false,
    },
    wishlist: {
      channelIds: Array.isArray(wishlist.channelIds)
        ? wishlist.channelIds.map(optionalString).filter((id): id is string => Boolean(id))
        : [],
    },
    welcome: { channelId: optionalString(welcome.channelId) },
    goodbye: { channelId: optionalString(goodbye.channelId) },
    dj: {
      language: djLanguage,
      voice: optionalString(dj.voice) ?? DJ_VOICES[djLanguage],
      model: optionalString(dj.model) ?? 'claude-opus-5-5',
      discover:
        typeof dj.discover === 'number' && Number.isFinite(dj.discover)
          ? Math.min(3, Math.max(0, Math.round(dj.discover)))
          : 2,
      blockSets:
        typeof dj.blockSets === 'number' && Number.isFinite(dj.blockSets)
          ? Math.min(4, Math.max(1, Math.round(dj.blockSets)))
          : 2,
      setsPerServerPerDay: wholeAtLeastZero(dj.setsPerServerPerDay) ?? 20,
      setsPerDay: wholeAtLeastZero(dj.setsPerDay) ?? 100,
    },
    embedColor: parseColor(raw.embedColor),
  };
}

function loadToken(): string {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.');
  }
  return token;
}

export const config: Config = loadConfig();
export const DISCORD_TOKEN: string = loadToken();
