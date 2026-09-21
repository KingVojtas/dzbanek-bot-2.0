import ffmpegPath from 'ffmpeg-static';
import '@snazzah/davey';
import 'libsodium-wrappers';
import { Cron } from 'croner';
import { Events, type Client } from 'discord.js';
import { buildCommandCollection } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { createClient } from './core/client';
import { logger, type Logger } from './core/logger';
import type { Services } from './core/types';
import { migrateJsonStoresIfNeeded } from './db/migrate-json';
import { EpicFreeGamesService } from './deals/epic/EpicFreeGamesService';
import { GuildSettingsStore } from './deals/guild-settings';
import { SeenStore } from './deals/seen-store';
import { SteamDealsService } from './deals/steam/SteamDealsService';
import { registerEvents } from './events';
import { KitchenBoard } from './kitchen/KitchenBoard';
import { KITCHEN_CHART_CRON } from './kitchen/chart';
import { RADIO_NIGHT_CRON } from './kitchen/display';
import { StereoPresence } from './kitchen/presence';
import { MusicManager } from './music/MusicManager';
import { RadioManager } from './radio/RadioManager';
import { getStation } from './radio/station';

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
  const kitchen = new KitchenBoard(client, music, radio, guildSettings, config, logger);
  const presence = new StereoPresence(client, music, radio, kitchen, logger);
  kitchen.setPresenceTick(() => presence.tick());
  radio.setOnStation((guildId, station) => {
    void guildSettings.upsert(guildId, { lastRadioStation: station.id }).catch((error) => {
      logger.debug('Failed to remember last radio station:', error);
    });
    presence.tick();
  });
  music.setIdleHandoff((guildId, channelId) => {
    void handOffIdleToRadio(client, radio, kitchen, guildSettings, logger, guildId, channelId);
  });
  const services: Services = {
    config,
    logger,
    music,
    radio,
    guildSettings,
    kitchen,
  };

  const steamService = new SteamDealsService(client, seen, config, logger, guildSettings);
  const epicService = new EpicFreeGamesService(client, seen, config, logger, guildSettings);
  steamService.setKitchen(kitchen);
  epicService.setKitchen(kitchen);

  registerEvents(client, commands, services);

  client.once(Events.ClientReady, () => {
    const runSteam = (reason: string) =>
      steamService.poll().catch((error) => logger.error(`${reason} Steam poll failed:`, error));
    const runEpic = (reason: string) =>
      epicService.poll().catch((error) => logger.error(`${reason} Epic poll failed:`, error));

    const cronOpts = { timezone: config.timezone, protect: true as const };
    const steamJob = new Cron(config.steam.cron, cronOpts, () => void runSteam('Scheduled'));
    logger.info(
      `Steam deals: cron "${config.steam.cron}" (${config.timezone}), next ${steamJob.nextRun()?.toISOString() ?? '?'}.`,
    );

    const epicJob = new Cron(config.epic.cron, cronOpts, () => void runEpic('Scheduled'));
    logger.info(
      `Epic free games: cron "${config.epic.cron}" (${config.timezone}), next ${epicJob.nextRun()?.toISOString() ?? '?'}.`,
    );

    kitchen.attach();
    presence.attach();
    void Promise.all([runSteam('Initial'), runEpic('Initial')]).finally(() => {
      void kitchen.refreshAll();
    });

    const radioNightJob = new Cron(RADIO_NIGHT_CRON, cronOpts, () => {
      void kitchen.runRadioNights().catch((error) => logger.error('Radio Night failed:', error));
    });
    logger.info(
      `Radio Night: cron "${RADIO_NIGHT_CRON}" (${config.timezone}), next ${radioNightJob.nextRun()?.toISOString() ?? '?'}.`,
    );

    const chartJob = new Cron(KITCHEN_CHART_CRON, cronOpts, () => {
      void kitchen
        .runWeeklyCharts(seen)
        .catch((error) => logger.error('Kitchen chart failed:', error));
    });
    logger.info(
      `Kitchen chart: cron "${KITCHEN_CHART_CRON}" (${config.timezone}), next ${chartJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    logger.info(`Multi-server ready: in ${client.guilds.cache.size} guild(s).`);
  });

  await client.login(DISCORD_TOKEN);
}

async function handOffIdleToRadio(
  client: Client,
  radio: RadioManager,
  kitchen: KitchenBoard,
  guildSettings: GuildSettingsStore,
  logger: Logger,
  guildId: string,
  channelId: string,
): Promise<void> {
  const settings = await guildSettings.get(guildId);
  if (!settings.idleRadioEnabled) return;

  const guild =
    client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;
  const raw =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!raw?.isVoiceBased()) return;

  const humans = [...raw.members.values()].filter((member) => !member.user.bot);
  if (humans.length === 0) {
    logger.info(`Idle → radio skipped in ${guild.name}: voice channel empty.`);
    return;
  }

  const station = getStation(settings.lastRadioStation ?? '') ?? getStation('beat');
  if (!station) return;

  try {
    await radio.play(raw, station);
    logger.info(`Idle → radio: ${station.name} in ${guild.name} (#${raw.name}).`);
    kitchen.refresh(guildId);
  } catch (error) {
    logger.error(`Idle → radio failed in ${guild.name}:`, error);
  }
}

main().catch((error) => {
  logger.error('Fatal error during startup:', error);
  process.exit(1);
});
