import './radio/ffmpeg-bin';
import ffmpegPath from 'ffmpeg-static';
import '@snazzah/davey';
import 'libsodium-wrappers';
import { Cron } from 'croner';
import { ChannelType, Events, Team, type Client, type User } from 'discord.js';
import { buildCommandCollection } from './commands';
import { DISCORD_TOKEN, config } from './config';
import { createClient } from './core/client';
import { claimInstance, type NewerCopy } from './core/instance-lock';
import { logger, type Logger } from './core/logger';
import { watchForTwin } from './core/twin-watch';
import type { Services } from './core/types';
import {
  ensureGuildSettingsColumns,
  ensurePlayLogTable,
  ensureQuizTables,
  ensureSongReactionTable,
  ensureSteamLinkTable,
} from './db/client';
import { migrateJsonStoresIfNeeded } from './db/migrate-json';
import { EpicFreeGamesService } from './deals/epic/EpicFreeGamesService';
import { GuildSettingsStore } from './deals/guild-settings';
import { SeenStore } from './deals/seen-store';
import { SteamDealsService } from './deals/steam/SteamDealsService';
import { WishlistRadar } from './deals/steam/WishlistRadar';
import { SteamLinkStore } from './deals/steam/steam-links';
import { registerEvents } from './events';
import { KitchenFm } from './fm/KitchenFm';
import { SongReactionStore } from './fm/reactions';
import { KitchenBoard } from './kitchen/KitchenBoard';
import { KITCHEN_CHART_CRON } from './kitchen/chart';
import { KITCHEN_WRAPPED_MONTH_CRON, KITCHEN_WRAPPED_YEAR_CRON } from './kitchen/wrapped';
import { RADIO_NIGHT_CRON } from './kitchen/display';
import { LorePresence } from './kitchen/presence';
import { MusicManager } from './music/MusicManager';
import { RadioCatchStore } from './kitchen/catches';
import { QuizManager } from './quiz/QuizManager';
import { PlayedTrackStore, PlayLogStore, QuizScoreStore } from './quiz/stores';
import { RadioManager } from './radio/RadioManager';
import { getStation } from './radio/station';

// ffmpeg-bin sets FFMPEG_BIN before this import resolves, so the path above is
// the binary that survived a real transcode. Keep FFMPEG_PATH pointed at it.
if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

/** Daily yt-dlp update, after the 03:33 Steam run. The play log is pruned on the same run. */
const YTDLP_UPDATE_CRON = '15 4 * * *';
/** Play-log rows older than this are dropped once a day. A year of Wrapped still fits. */
const PLAY_LOG_KEEP_DAYS = 400;

async function main(): Promise<void> {
  const client = createClient();
  const commands = buildCommandCollection();

  await ensureGuildSettingsColumns();
  await ensureSteamLinkTable();
  await ensureQuizTables();
  await ensureSongReactionTable();
  await ensurePlayLogTable();
  await migrateJsonStoresIfNeeded();

  const guildSettings = new GuildSettingsStore();
  const seen = new SeenStore(config.steam.maxSeenIds);
  const steamLinks = new SteamLinkStore();
  const wishlistRadar = new WishlistRadar(steamLinks, seen, logger);
  const music = new MusicManager(config, logger);
  const radio = new RadioManager(logger);
  // Set once this copy gives way, or a signal starts the shutdown.
  let stopped = false;
  music.setPreempt((guildId) => radio.stop(guildId));
  const kitchen = new KitchenBoard(client, music, radio, guildSettings, config, logger);
  const presence = new LorePresence(client, logger, config.timezone);
  const played = new PlayedTrackStore();
  const playLog = new PlayLogStore();
  const catches = new RadioCatchStore();
  const quiz = new QuizManager(music, radio, played, catches, new QuizScoreStore(), logger);
  const fm = new KitchenFm(music, played, catches, new SongReactionStore(), config, logger);
  kitchen.setGenreOf((songKey) => fm.genreOf(songKey));
  music.setFireCounts((guildId, track) => fm.fires(guildId, track));
  music.setOnTrackStart((guildId, track) => {
    // Kitchen FM's own picks are already kitchen songs; replaying one is not a new /play.
    if (!track.stationPick) {
      void played.record(guildId, track).catch((error) => {
        logger.debug('Failed to remember a played track:', error);
      });
    }
    const noted = fm.describe(guildId, track);
    void playLog
      .add({
        guildId,
        url: track.url,
        title: noted.title,
        artist: noted.artist,
        songKey: noted.key,
        requestedById: track.requestedById ?? null,
        kind: noted.kind,
        durationSec: track.durationSec,
      })
      .catch((error) => {
        logger.debug('Failed to log a play:', error);
      });
  });
  kitchen.setBusy((guildId) => quiz.isActive(guildId));
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
    if (stopped) return;
    void handOffIdleToRadio(
      client,
      radio,
      kitchen,
      guildSettings,
      logger,
      guildId,
      channelId,
      () => !stopped,
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
    quiz,
    fm,
  };

  const steamService = new SteamDealsService(client, seen, config, logger, guildSettings);
  const epicService = new EpicFreeGamesService(client, seen, config, logger, guildSettings);
  steamService.setKitchen(kitchen);
  steamService.setRadar(wishlistRadar);
  epicService.setKitchen(kitchen);

  registerEvents(client, commands, services);

  const jobs: Cron[] = [];
  let idle = false;
  let stopLock = (): void => {};
  const stopBenchmark = new AbortController();
  // Cron jobs plus the voice sessions. Shutdown exits after this; going idle does not.
  const release = () => {
    for (const job of jobs) job.stop();
    radio.stopAll();
    music.stopAll();
    quiz.stopAll();
  };

  // A newer boot shares data/ and would take the voice connection back and forth.
  // Exiting here would let Docker restart this copy, and the two would take turns.
  async function goDormant(other: NewerCopy): Promise<void> {
    if (stopped) return;
    stopped = true;
    idle = true;
    stopBenchmark.abort();
    stopLock();
    logger.warn(
      `A newer copy is running on ${other.host} (pid ${other.pid}, started ${other.startedAt}).`,
    );
    release();
    try {
      await client.destroy();
    } catch (error) {
      logger.debug('Client destroy while going idle:', error);
    }
    logger.info('This copy is now idle; the newer one runs the bot.');
    // An unref'd timer would let Node exit, and Docker would start this copy again.
    setInterval(() => {}, 60 * 60_000);
  }

  const lock = claimInstance({
    logger,
    onNewer: (other) => {
      void goDormant(other).catch((error) => logger.error('Could not go idle:', error));
    },
  });
  stopLock = () => lock.stop();

  client.once(Events.ClientReady, () => {
    if (stopped) return;
    const runSteam = (reason: string) =>
      steamService.poll().catch((error) => logger.error(`${reason} Steam poll failed:`, error));
    const runEpic = (reason: string) =>
      epicService.poll().catch((error) => logger.error(`${reason} Epic poll failed:`, error));

    const cronOpts = { timezone: config.timezone, protect: true as const };
    const steamJob = new Cron(config.steam.cron, cronOpts, () => void runSteam('Scheduled'));
    jobs.push(steamJob);
    logger.info(
      `Steam deals: cron "${config.steam.cron}" (${config.timezone}), next ${steamJob.nextRun()?.toISOString() ?? '?'}.`,
    );

    const epicJob = new Cron(config.epic.cron, cronOpts, () => void runEpic('Scheduled'));
    jobs.push(epicJob);
    logger.info(
      `Epic free games: cron "${config.epic.cron}" (${config.timezone}), next ${epicJob.nextRun()?.toISOString() ?? '?'}.`,
    );

    kitchen.attach();
    presence.attach();
    void syncAboutMe(client, logger);
    void resumeRadios(client, radio, kitchen, guildSettings, logger, () => !stopped).catch(
      (error) => {
        logger.error('Radio resume failed:', error);
      },
    );
    void Promise.all([runSteam('Initial'), runEpic('Initial')]).finally(() => {
      void kitchen.refreshAll().catch((error) => logger.error('Kitchen refresh failed:', error));
    });

    const radioNightJob = new Cron(RADIO_NIGHT_CRON, cronOpts, () => {
      if (stopped) return;
      void kitchen.runRadioNights().catch((error) => logger.error('Radio Night failed:', error));
    });
    logger.info(
      `Radio Night: cron "${RADIO_NIGHT_CRON}" (${config.timezone}), next ${radioNightJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    jobs.push(radioNightJob);

    const chartJob = new Cron(KITCHEN_CHART_CRON, cronOpts, () => {
      if (stopped) return;
      void kitchen
        .runWeeklyCharts(seen)
        .catch((error) => logger.error('Kitchen chart failed:', error));
    });
    logger.info(
      `Kitchen chart: cron "${KITCHEN_CHART_CRON}" (${config.timezone}), next ${chartJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    jobs.push(chartJob);

    // Month and year share one chain so 1 January posts the month, then the year.
    let wrappedChain: Promise<void> = Promise.resolve();
    const runWrapped = (kinds: Array<'month' | 'year'>) => {
      if (stopped) return;
      wrappedChain = wrappedChain
        .then(async () => {
          if (stopped) return;
          for (const kind of kinds) {
            if (stopped) return;
            await kitchen.runKitchenWrapped(seen, kind);
          }
        })
        .catch((error) => logger.error('Kitchen Wrapped failed:', error));
    };
    const wrappedMonthJob = new Cron(KITCHEN_WRAPPED_MONTH_CRON, cronOpts, () =>
      runWrapped(['month']),
    );
    logger.info(
      `Kitchen Wrapped month: cron "${KITCHEN_WRAPPED_MONTH_CRON}" (${config.timezone}), next ${wrappedMonthJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    jobs.push(wrappedMonthJob);
    const wrappedYearJob = new Cron(KITCHEN_WRAPPED_YEAR_CRON, cronOpts, () =>
      runWrapped(['month', 'year']),
    );
    logger.info(
      `Kitchen Wrapped year: cron "${KITCHEN_WRAPPED_YEAR_CRON}" (${config.timezone}), next ${wrappedYearJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    jobs.push(wrappedYearJob);

    // A YouTube check after each boot and each morning's update; each run also
    // lets yt-dlp save the cookies YouTube refreshed.
    music.setYouTubeAlert((text) => dmOwner(client, text, logger));
    void ownerUser(client).then(
      (user) =>
        logger.info(user ? `YouTube alerts DM ${user.username}.` : 'YouTube alerts: no bot owner.'),
      (error: unknown) => logger.warn('Could not look up the bot owner:', error),
    );
    void music.checkYouTube().then(
      (passed) => {
        if (!passed || stopped) return;
        music.benchmarkYouTubeClients(stopBenchmark.signal);
      },
      (error: unknown) => logger.warn('YouTube check failed:', error),
    );
    const ytDlpJob = new Cron(YTDLP_UPDATE_CRON, cronOpts, () => {
      if (stopped) return;
      void music.updateYtDlp().then(() => music.checkYouTube());
      const cutoff = new Date(Date.now() - PLAY_LOG_KEEP_DAYS * 86_400_000);
      void playLog
        .prune(cutoff)
        .then((removed) => {
          if (removed > 0) {
            logger.info(`Play log: pruned ${removed} rows older than ${PLAY_LOG_KEEP_DAYS} days.`);
          }
        })
        .catch((error) => logger.warn('Play log prune failed:', error));
    });
    jobs.push(ytDlpJob);
    logger.info(
      `yt-dlp update: cron "${YTDLP_UPDATE_CRON}" (${config.timezone}), next ${ytDlpJob.nextRun()?.toISOString() ?? '?'}.`,
    );
    logger.info(`Multi-server ready: in ${client.guilds.cache.size} guild(s).`);
  });

  const shutdown = (signal: string) => {
    stopBenchmark.abort();
    // Already idle: a stop signal still ends the container. Docker is not waiting on us.
    if (idle) {
      process.exit(0);
      return;
    }
    if (stopped) return;
    stopped = true;
    lock.stop();
    logger.info(`${signal} received — leaving voice and shutting down.`);
    // Keep the saved radio channel so the next boot resumes the station.
    release();
    void client
      .destroy()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  watchForTwin(client, logger, (text) => dmOwner(client, text, logger));
  try {
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    // destroy() during login rejects it. Stay up; exiting would restart this copy.
    if (idle) return;
    throw error;
  }
}

// One stray promise must not take music, radio, and deals down with it.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

/** The bot profile's About Me. Discord caps it at 400 characters. */
const ABOUT_ME =
  '🍪 Dzbanek — the kitchen’s stereo. Plays YouTube & Spotify, streams live radio, and runs ' +
  'Kitchen FM: your own station with a DJ who reads your dedications. 🔥 the songs you love, ' +
  'name that tune in the Kitchen Quiz, and get a Kitchen Wrapped every month. Steam deals and ' +
  'Epic freebies, too.\n\nType /help to see what’s cooking.';

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

/** Whoever owns the bot in the Developer Portal: the user, or a team's owner. */
async function ownerUser(client: Client): Promise<User | null> {
  const owner = (await client.application?.fetch())?.owner;
  return owner instanceof Team ? (owner.owner?.user ?? null) : (owner ?? null);
}

/** DM the bot's owner. No owner, or closed DMs, cost only a warning. */
async function dmOwner(client: Client, text: string, logger: Logger): Promise<void> {
  try {
    const user = await ownerUser(client);
    if (!user) {
      logger.warn('No bot owner to DM.');
      return;
    }
    await user.send(text);
  } catch (error) {
    logger.warn('Could not DM the bot owner:', error);
  }
}

async function resumeRadios(
  client: Client,
  radio: RadioManager,
  kitchen: KitchenBoard,
  guildSettings: GuildSettingsStore,
  logger: Logger,
  alive: () => boolean,
): Promise<void> {
  const rows = await guildSettings.all();
  for (const row of rows) {
    if (!alive()) return;
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

    if (!alive()) return;
    try {
      await radio.play(raw, station);
      if (!alive()) {
        radio.stop(row.guildId);
        return;
      }
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
  alive: () => boolean,
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
  if (!station || !alive()) return;

  try {
    await radio.play(raw, station);
    if (!alive()) {
      radio.stop(guildId);
      return;
    }
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
