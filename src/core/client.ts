import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Guilds: slash commands + channel access.
 * GuildVoiceStates: join/leave the caller's voice channel for music.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}
