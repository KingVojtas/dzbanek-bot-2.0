import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Guilds: slash commands + channel access.
 * GuildVoiceStates: join/leave the caller's voice channel for music.
 * GuildMembers: welcome/goodbye (requires Server Members Intent in the portal).
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });
}
