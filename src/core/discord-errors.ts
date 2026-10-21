import { DiscordAPIError } from 'discord.js';

/** Discord 10008: the message was deleted (or never existed). */
export function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && Number(error.code) === 10008;
}
