import ffmpegPath from 'ffmpeg-static';
import '@snazzah/davey';
import 'libsodium-wrappers';
import { Cron } from 'croner';
import { Events } from 'discord.js';
import { buildCommandCollection } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { createClient } from './core/client';
import { logger } from './core/logger';
import type { Services } from './core/types';
import { migrateJsonStoresIfNeeded } from './db/migrate-json';
import { EpicFreeGamesService } from './deals/epic/EpicFreeGamesService';
import { GuildSettingsStore } from './deals/guild-settings';
import { SeenStore } from './deals/seen-store';
import { SteamDealsService } from './deals/steam/SteamDealsService';
import { registerEvents } from './events';
import { MusicManager } from './music/MusicManager';
import { RadioManager } from './radio/RadioManager';

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

async function main(): Promise<void> {
  const client = createClient();
  const commands = buildCommandCollection();

  await migrateJsonStoresIfNeeded();

  const guildSettings = new GuildSettingsStore();
  const seen = new SeenStore(config.steam.maxSeenIds);
  const music = new MusicManager(config, logger);
  const radio = new RadioManager(logger);
  music.setPreempt((guildId) => radio.stop(guildId));
  const services: Services = {
    config,
    logger,
    music,
    radio,
    guildSettings,
  };

  const steamService = new SteamDealsService(client, seen, config, logger, guildSettings);
  const epicService = new EpicFreeGamesService(client, seen, config, logger, guildSettings);

  registerEvents(client, commands, services);

  client.once(Events.ClientReady, () => {
    const runSteam = (reason: string) =>
      void steamService
        .poll()
        .catch((error) => logger.error(`${reason} Steam poll failed:`, error));
    const runEpic = (reason: string) =>
      void epicService.poll().catch((error) => logger.error(`${reason} Epic poll failed:`, error));

    const cronOpts = { timezone: config.timezone, protect: true as const };
    runSteam('Initial');
    const steamJob = new Cron(config.steam.cron, cronOpts, () => runSteam('Scheduled'));
    logger.info(
      `Steam deals: cron "${config.steam.cron}" (${config.timezone}), next ${steamJob.nextRun()?.toISOString() ?? '?'}.`,
    );

    runEpic('Initial');
    const epicJob = new Cron(config.epic.cron, cronOpts, () => runEpic('Scheduled'));
    logger.info(
      `Epic free games: cron "${config.epic.cron}" (${config.timezone}), next ${epicJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    logger.info(`Multi-server ready: in ${client.guilds.cache.size} guild(s).`);
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});
