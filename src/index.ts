import './radio/ffmpeg-bin';
import ffmpegPath from 'ffmpeg-static';
import '@snazzah/davey';
import 'libsodium-wrappers';
import { Cron } from 'croner';
import { ChannelType, Events, type Client } from 'discord.js';
import { buildCommandCollection } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { createClient } from './core/client';
import { logger, type Logger } from './core/logger';
import type { Services } from './core/types';
import { ensureGuildSettingsColumns, ensureSteamLinkTable } from './db/client';
import { migrateJsonStoresIfNeeded } from './db/migrate-json';
import { EpicFreeGamesService } from './deals/epic/EpicFreeGamesService';
import { GuildSettingsStore } from './deals/guild-settings';
import { SeenStore } from './deals/seen-store';
import { SteamDealsService } from './deals/steam/SteamDealsService';
import { WishlistRadar } from './deals/steam/WishlistRadar';
import { SteamLinkStore } from './deals/steam/steam-links';
import { registerEvents } from './events';
import { KitchenBoard } from './kitchen/KitchenBoard';
import { KITCHEN_CHART_CRON } from './kitchen/chart';
import { RADIO_NIGHT_CRON } from './kitchen/display';
import { LorePresence } from './kitchen/presence';
import { MusicManager } from './music/MusicManager';
import { RadioManager } from './radio/RadioManager';
import { getStation } from './radio/station';

// ffmpeg-bin sets FFMPEG_BIN before this import resolves, so the path above is
// the binary that survived a real transcode. Keep FFMPEG_PATH pointed at it.
if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

async function main(): Promise<void> {
  const client = createClient();
  const commands = buildCommandCollection();

  await ensureGuildSettingsColumns();
  await ensureSteamLinkTable();
  await migrateJsonStoresIfNeeded();

  const guildSettings = new GuildSettingsStore();
  const seen = new SeenStore(config.steam.maxSeenIds);
  const steamLinks = new SteamLinkStore();
  const wishlistRadar = new WishlistRadar(steamLinks, seen, logger);
  const music = new MusicManager(config, logger);
  const radio = new RadioManager(logger);
  music.setPreempt((guildId) => radio.stop(guildId));
  const kitchen = new KitchenBoard(client, music, radio, guildSettings, config, logger);
  const presence = new LorePresence(client, logger, config.timezone);
  radio.setOnStation((guildId, station, channelId) => {
    void guildSettings
      .upsert(guildId, { lastRadioStation: station.id, lastRadioChannelId: channelId })
      .catch((error) => {
        logger.debug('Failed to remember last radio station:', error);
      });
  });
  radio.setOnLeave((guildId) => {
    void guildSettings.upsert(guildId, { lastRadioChannelId: null }).catch((error) => {
      logger.debug('Failed to forget last radio channel:', error);
    });
  });
  music.setIdleHandoff((guildId, channelId) => {
    void handOffIdleToRadio(
      client,
      radio,
      kitchen,
      guildSettings,
      logger,
      guildId,
      channelId,
    ).catch((error) => logger.error('Idle → radio failed:', error));
  });
  const services: Services = {
    config,
    logger,
    music,
    radio,
    guildSettings,
    kitchen,
    steamLinks,
    wishlistRadar,
  };

  const steamService = new SteamDealsService(client, seen, config, logger, guildSettings);
  const epicService = new EpicFreeGamesService(client, seen, config, logger, guildSettings);
  steamService.setKitchen(kitchen);
  steamService.setRadar(wishlistRadar);
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
    void syncAboutMe(client, logger);
    void resumeRadios(client, radio, kitchen, guildSettings, logger).catch((error) => {
      logger.error('Radio resume failed:', error);
    });
    void Promise.all([runSteam('Initial'), runEpic('Initial')]).finally(() => {
      void kitchen.refreshAll().catch((error) => logger.error('Kitchen refresh failed:', error));
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

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — leaving voice and shutting down.`);
    // Keep the saved radio channel so the next boot resumes the station.
    radio.stopAll();
    music.stopAll();
    void client
      .destroy()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(DISCORD_TOKEN);
}

// One stray promise must not take music, radio, and deals down with it.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

/** The bot profile's About Me. Discord caps it at 400 characters. */
const ABOUT_ME =
  '🍪 Dzbanek — the kitchen’s stereo. Plays YouTube & Spotify, streams Kiss, Rock Radio & Beat live, ' +
  'posts Steam deals every morning and Epic freebies when they drop, and keeps a cookie warm for ' +
  'whoever walks in.\n\nType /help to see what’s cooking.';

/** Write the About Me only when it differs, so a restart does not spam the API. */
async function syncAboutMe(client: Client, logger: Logger): Promise<void> {
  try {
    const application = await client.application?.fetch();
    if (!application || application.description === ABOUT_ME) return;
    await application.edit({ description: ABOUT_ME });
    logger.info('About Me updated.');
  } catch (error) {
    logger.warn('Could not update About Me:', error);
  }
}

async function resumeRadios(
  client: Client,
  radio: RadioManager,
  kitchen: KitchenBoard,
  guildSettings: GuildSettingsStore,
  logger: Logger,
): Promise<void> {
  const rows = await guildSettings.all();
  for (const row of rows) {
    if (!row.idleRadioEnabled || !row.lastRadioChannelId || !row.lastRadioStation) continue;
    const station = getStation(row.lastRadioStation);
    if (!station) continue;

    const guild =
      client.guilds.cache.get(row.guildId) ??
      (await client.guilds.fetch(row.guildId).catch(() => null));
    if (!guild) continue;

    const raw =
      guild.channels.cache.get(row.lastRadioChannelId) ??
      (await guild.channels.fetch(row.lastRadioChannelId).catch(() => null));
    if (!raw?.isVoiceBased() || raw.type === ChannelType.GuildStageVoice) {
      logger.info(`Radio resume skipped in ${guild.name}: channel is not a voice channel.`);
      continue;
    }

    const humans = [...raw.members.values()].filter((member) => !member.user.bot);
    if (humans.length === 0) {
      logger.info(`Radio resume skipped in ${guild.name}: voice channel empty.`);
      continue;
    }

    try {
      await radio.play(raw, station);
      logger.info(`Radio resume: ${station.name} in ${guild.name} (#${raw.name}).`);
      kitchen.refresh(row.guildId);
    } catch (error) {
      logger.error(`Radio resume failed in ${guild.name}:`, error);
    }
  }
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
