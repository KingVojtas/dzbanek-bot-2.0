import { REST, Routes } from 'discord.js';
import { commandList } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { logger } from './core/logger';

/**
 * A guild command hides the global command of the same name, and global
 * commands can take an hour to appear. These servers get the current list
 * directly so new commands show up immediately.
 */
const INSTANT_GUILD_IDS = ['1497774735419773029', '1408523705776214128'];

async function main(): Promise<void> {
  const body = commandList.map((command) => command.data.toJSON());
  const names = body.map((command) => command.name).join(', ');
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const guildIds = new Set(INSTANT_GUILD_IDS);
  if (config.discord.guildId) guildIds.add(config.discord.guildId);

  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guildId), { body });
    logger.info(`Registered ${body.length} guild command(s) for ${guildId}: ${names}.`);
  }

  await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
  logger.info(
    `Registered ${body.length} global command(s) (other servers can take up to ~1 hour): ${names}.`,
  );
}

main().catch((error) => {
  logger.error('Failed to deploy commands:', error);
  process.exit(1);
});
