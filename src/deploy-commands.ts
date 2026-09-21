import { REST, Routes } from 'discord.js';
import { commandList } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { logger } from './core/logger';

/**
 * Guild commands with the same name hide the global ones. These two servers
 * still have an older copy, so every deploy wipes them before publishing global.
 */
const SHADOW_GUILD_IDS = ['1497774735419773029', '1408523705776214128'];

async function main(): Promise<void> {
  const body = commandList.map((command) => command.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const guildIds = new Set(SHADOW_GUILD_IDS);
  if (config.discord.guildId) guildIds.add(config.discord.guildId);

  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guildId), { body: [] });
    logger.info(`Cleared guild commands for ${guildId}.`);
  }

  await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
  logger.info(
    `Registered ${body.length} global command(s) (can take up to ~1 hour to replace the old names).`,
  );
}

main().catch((error) => {
  logger.error('Failed to deploy commands:', error);
  process.exit(1);
});
