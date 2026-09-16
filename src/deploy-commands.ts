import { REST, Routes } from 'discord.js';
import { commandList } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { logger } from './core/logger';

async function main(): Promise<void> {
  const body = commandList.map((command) => command.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  if (config.discord.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
      body,
    });
    logger.info(
      `Registered ${body.length} guild command(s) for ${config.discord.guildId} (instant).`,
    );
  } else {
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
    logger.info(`Registered ${body.length} global command(s) (can take up to ~1 hour to appear).`);
  }
}

main().catch((error) => {
  logger.error('Failed to deploy commands:', error);
  process.exit(1);
});
