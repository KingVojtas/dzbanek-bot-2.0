/**
 * Live smoke-check: ffmpeg, yt-dlp, Spotify, Steam RSS, Epic API, Discord login.
 * Does not post to any Discord channel.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DISCORD_TOKEN, config } from '../src/config';
import { STEAM_DIGEST_SIZE } from '../src/core/display';
import { SteamFeedReader } from '../src/deals/steam/SteamFeedReader';
import { extractAppId, fetchSteamPrice } from '../src/deals/steam/SteamPriceApi';
import { fetchSteamReview, isGoodReview } from '../src/deals/steam/SteamReviewApi';
import { selectSteamDigest, uniqueSteamApps } from '../src/deals/steam/select-digest';
import type { SteamReviewInfo } from '../src/deals/steam/SteamReviewApi';
import { YouTubeSource } from '../src/music/sources/youtube';

const execFileAsync = promisify(execFile);

const EPIC_API_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions' +
  '?locale=en-US&country=US&allowCountries=US';

let failed = 0;

function ok(name: string, detail: string): void {
  console.log(`PASS  ${name} — ${detail}`);
}

function fail(name: string, detail: string): void {
  failed += 1;
  console.error(`FAIL  ${name} — ${detail}`);
}

async function checkFfmpeg(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 10_000 });
    ok('ffmpeg', stdout.split('\n')[0]?.trim() || 'present');
  } catch (error) {
    fail('ffmpeg', error instanceof Error ? error.message : String(error));
  }
}

async function checkYoutube(): Promise<void> {
  const source = new YouTubeSource();
  try {
    const tracks = await source.resolve('https://www.youtube.com/watch?v=jNQXAC9IVRw', 'verify');
    const track = tracks[0];
    if (!track?.title) {
      fail('youtube-resolve-url', `no track: ${JSON.stringify(tracks)}`);
      return;
    }
    ok('youtube-resolve-url', track.title);
  } catch (error) {
    fail('youtube-resolve-url', error instanceof Error ? error.message.slice(0, 400) : String(error));
  }

  try {
    const tracks = await source.resolve('never gonna give you up', 'verify');
    const track = tracks[0];
    if (!track?.title) {
      fail('youtube-search', `no track: ${JSON.stringify(tracks)}`);
      return;
    }
    ok('youtube-search', track.title);
  } catch (error) {
    fail('youtube-search', error instanceof Error ? error.message.slice(0, 400) : String(error));
  }

  try {
    const tracks = await source.resolve('https://www.youtube.com/watch?v=jNQXAC9IVRw', 'verify');
    const track = tracks[0];
    if (!track) {
      fail('youtube-stream', 'resolve returned nothing');
      return;
    }
    const stream = await source.stream(track);
    const first = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no bytes after 25s')), 25_000);
      stream.once('data', () => {
        clearTimeout(timer);
        stream.destroy();
        resolve(true);
      });
      stream.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    ok('youtube-stream', first ? 'received audio bytes' : 'no data');
  } catch (error) {
    fail('youtube-stream', error instanceof Error ? error.message.slice(0, 400) : String(error));
  }
}

async function checkSpotify(): Promise<void> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    fail('spotify-auth', 'SPOTIFY_CLIENT_ID / SECRET missing');
    return;
  }
  try {
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await response.text();
    if (!response.ok) {
      fail('spotify-auth', `HTTP ${response.status}: ${body.slice(0, 200)}`);
      return;
    }
    const json = JSON.parse(body) as { access_token?: string };
    if (!json.access_token) {
      fail('spotify-auth', 'no access_token in response');
      return;
    }
    ok('spotify-auth', 'client-credentials token issued');
  } catch (error) {
    fail('spotify-auth', error instanceof Error ? error.message : String(error));
  }
}

async function checkSteam(): Promise<void> {
  try {
    const items = await new SteamFeedReader().read();
    if (items.length === 0) {
      fail('steam-rss', 'feed returned 0 items');
      return;
    }
    ok('steam-rss', `${items.length} deal(s), e.g. ${items[0]?.gameName}`);
    if (items.length < STEAM_DIGEST_SIZE) {
      fail('steam-digest-size', `feed has ${items.length} items, need ${STEAM_DIGEST_SIZE}`);
    } else {
      const unique = uniqueSteamApps(items);
      const passing: SteamReviewInfo = {
        score: 8,
        scoreDesc: 'Very Positive',
        totalReviews: 100,
        positivePct: 90,
      };
      const reviews = new Map(unique.map((item) => [item.id, passing] as const));
      const digest = selectSteamDigest(unique, reviews, STEAM_DIGEST_SIZE);
      if (digest.length !== STEAM_DIGEST_SIZE) {
        fail(
          'steam-digest-size',
          `selectSteamDigest returned ${digest.length}, expected ${STEAM_DIGEST_SIZE}`,
        );
      } else {
        ok('steam-digest-size', `${digest.length} games, top ${digest[0]?.gameName}`);
      }
    }

    const withApp = items.find((item) => extractAppId(item.link));
    const appId = withApp ? extractAppId(withApp.link) : null;
    if (!appId) {
      fail('steam-enrich', 'no Steam app ID in feed');
      return;
    }
    const [review, price] = await Promise.all([fetchSteamReview(appId), fetchSteamPrice(appId)]);
    ok(
      'steam-enrich',
      `app ${appId} review=${review ? `${review.scoreDesc} good=${isGoodReview(review)}` : 'null'} price=${price ? price.finalFormatted : 'null'}`,
    );
  } catch (error) {
    fail('steam-rss', error instanceof Error ? error.message : String(error));
  }
}

async function checkEpic(): Promise<void> {
  try {
    const response = await fetch(EPIC_API_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      fail('epic-api', `HTTP ${response.status}`);
      return;
    }
    const json = (await response.json()) as {
      data?: { Catalog?: { searchStore?: { elements?: { title: string }[] } } };
    };
    const elements = json.data?.Catalog?.searchStore?.elements ?? [];
    if (elements.length === 0) {
      fail('epic-api', 'no catalog elements');
      return;
    }
    ok('epic-api', `${elements.length} catalog element(s)`);
  } catch (error) {
    fail('epic-api', error instanceof Error ? error.message : String(error));
  }
}

async function checkDiscord(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('login timed out (15s)')), 15_000);
      client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
      client.once('error', reject);
    });
    await client.login(DISCORD_TOKEN);
    await ready;
    const tag = client.user?.tag ?? '?';
    const guilds = client.guilds.cache.size;
    ok(
      'discord-login',
      `${tag} in ${guilds} guild(s); clientId config=${config.discord.clientId} userId=${client.user?.id}`,
    );
    if (client.user?.id !== config.discord.clientId) {
      fail('discord-clientId', `config clientId ${config.discord.clientId} != logged-in ${client.user?.id}`);
    }
  } catch (error) {
    fail('discord-login', error instanceof Error ? error.message : String(error));
  } finally {
    await client.destroy();
  }
}

async function main(): Promise<void> {
  console.log('Running live verification (no Discord posts)…\n');
  await checkFfmpeg();
  await checkSpotify();
  await checkSteam();
  await checkEpic();
  await checkYoutube();
  await checkDiscord();
  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Verifier crashed:', error);
  process.exit(1);
});
