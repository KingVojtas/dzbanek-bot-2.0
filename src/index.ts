import '@snazzah/davey';
import 'libsodium-wrappers';
import { Cron } from 'croner';
import { Events } from 'discord.js';
import { buildCommandCollection } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { createClient } from './core/client';
import { logger } from './core/logger';
import type { Services } from './core/types';
import { EpicFreeGamesService } from './deals/epic/EpicFreeGamesService';
import { SeenStore } from './deals/seen-store';
import { SteamDealsService } from './deals/steam/SteamDealsService';
import { registerEvents } from './events';
import { MusicManager } from './music/MusicManager';

async function main(): Promise<void> {
  const client = createClient();
  const commands = buildCommandCollection();

  const services: Services = {
    config,
    logger,
    music: new MusicManager(config, logger),
  };

  const steamStore = new SeenStore('data/steam-seen.json', config.steam.maxSeenIds);
  const epicStore = new SeenStore('data/epic-seen.json', 50);

  const steamService = new SteamDealsService(client, steamStore, config, logger);
  const epicService = new EpicFreeGamesService(client, epicStore, config, logger);

  registerEvents(client, commands, services);

  client.once(Events.ClientReady, () => {
    const runSteam = (reason: string) =>
      void steamService.poll().catch((error) => logger.error(`${reason} Steam poll failed:`, error));
    const runEpic = (reason: string) =>
      void epicService.poll().catch((error) => logger.error(`${reason} Epic poll failed:`, error));

    runSteam('Initial');
    new Cron(config.steam.cron, () => runSteam('Scheduled'));
    logger.info(`Steam deals polling scheduled (cron "${config.steam.cron}").`);

    runEpic('Initial');
    new Cron(config.epic.cron, () => runEpic('Scheduled'));
    logger.info(`Epic free games polling scheduled (cron "${config.epic.cron}").`);
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});
