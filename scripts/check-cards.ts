/**
 * Serializes every card the bot posts. The website's cards are classic embeds:
 * Discord rejects an embed past its text limits and a row with more than five
 * buttons. /help stays Components V2: a section without a thumbnail or button
 * throws, and a message may nest at most 40 components.
 */
import { commandList } from '../src/commands';
import { buildHelpDisplay } from '../src/commands/help';
import {
  buildEpicFreeGamesDisplay,
  buildNowPlayingDisplay,
  buildQueueDisplay,
  buildSteamDealsDisplay,
  collectMessageTextContent,
  epicGameTitle,
  extractEpicTitles,
  extractSteamDigestTitles,
  looksLikeEpicDigest,
  looksLikeSteamDigest,
  selectEpicLineup,
  steamDealTitle,
} from '../src/core/display';
import { buildSiteEmbed, type EmbedCard } from '../src/core/embeds';
import type { EpicFreeGame, SteamDealItem, Track } from '../src/core/types';
import type { SteamReviewInfo } from '../src/deals/steam/SteamReviewApi';
import {
  buildKitchenBoardDisplay,
  kitchenViewKey,
  looksLikeKitchenBoard,
  type KitchenBoardView,
} from '../src/kitchen/display';
import { buildRadioPlayingDisplay } from '../src/radio/embed';
import { STATIONS } from '../src/radio/station';

const V2_COMPONENT_MAX = 40;
const SECTION = 9;
const BUTTON = 2;
const THUMBNAIL = 11;

let failed = 0;

function fail(name: string, detail: string): void {
  failed += 1;
  console.error(`FAIL  ${name} — ${detail}`);
}

function ok(name: string, detail: string): void {
  console.log(`PASS  ${name} — ${detail}`);
}

interface JsonNode {
  type?: number;
  accessory?: JsonNode;
  url?: string;
}

function collect(node: unknown, out: JsonNode[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as JsonNode & Record<string, unknown>;
  if (typeof rec.type === 'number') out.push(rec);
  for (const value of Object.values(rec)) {
    if (value && typeof value === 'object') collect(value, out);
  }
}

/** Components V2 card (/help). */
function checkCard(name: string, build: () => { components: { toJSON: () => unknown }[] }): void {
  let json: unknown;
  try {
    json = build().components.map((component) => component.toJSON());
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
    return;
  }
  const components: JsonNode[] = [];
  collect(json, components);
  if (components.length > V2_COMPONENT_MAX) {
    fail(name, `${components.length} components (max ${V2_COMPONENT_MAX})`);
    return;
  }
  const bare = components.filter(
    (component) =>
      component.type === SECTION &&
      component.accessory?.type !== THUMBNAIL &&
      component.accessory?.type !== BUTTON,
  );
  if (bare.length > 0) {
    fail(name, `${bare.length} section(s) without a thumbnail or button`);
    return;
  }
  ok(name, `${components.length} components`);
}

interface EmbedJson {
  author?: { name?: string };
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text?: string };
}

function embedLength(embed: EmbedJson): number {
  return (
    (embed.author?.name?.length ?? 0) +
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text?.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

/** Website card: classic embeds plus button rows. Returns the text for further checks. */
function checkEmbedCard(name: string, build: () => EmbedCard, wants: string[] = []): string {
  let card: EmbedCard;
  try {
    card = build();
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
    return '';
  }
  const embeds = card.embeds.map((embed) => embed.toJSON() as EmbedJson);
  const rows = card.components.map((row) => row.toJSON() as { components: unknown[] });
  const total = embeds.reduce((sum, embed) => sum + embedLength(embed), 0);
  const problems: string[] = [];
  if (embeds.length === 0 || embeds.length > 10) problems.push(`${embeds.length} embeds`);
  if (total > 6000) problems.push(`${total} characters (max 6000)`);
  for (const embed of embeds) {
    if ((embed.description?.length ?? 0) > 4096) problems.push('description over 4096');
    if ((embed.fields?.length ?? 0) > 25) problems.push('more than 25 fields');
    if ((embed.fields ?? []).some((f) => !f.name.trim() || !f.value.trim())) {
      problems.push('an empty field');
    }
  }
  if (rows.length > 5) problems.push(`${rows.length} button rows (max 5)`);
  if (rows.some((row) => row.components.length === 0 || row.components.length > 5)) {
    problems.push('a button row with 0 or more than 5 buttons');
  }
  const text = JSON.stringify({ embeds, rows });
  const missing = wants.filter((want) => !text.includes(want));
  if (missing.length > 0) problems.push(`missing ${missing.join(' | ')}`);
  if (problems.length > 0) {
    fail(name, problems.join('; '));
    return text;
  }
  ok(name, `${embeds.length} embed(s), ${total} characters, ${rows.length} row(s)`);
  return text;
}

/** The text a duplicate check would see on the posted message. */
function messageText(card: EmbedCard): string {
  return collectMessageTextContent({
    embeds: card.embeds.map((embed) => embed.toJSON()),
    components: card.components,
  });
}

function quietView(): KitchenBoardView {
  return {
    stereo: {
      kind: 'quiet',
      title: 'The Kitchen',
      artist: 'Nothing on.',
      sourceLabel: 'The Kitchen',
      color: 0xc4783a,
    },
    listeners: [],
    joinsToday: 0,
  };
}

function rockView(): KitchenBoardView {
  const rock = STATIONS.rock;
  return {
    stereo: {
      kind: 'radio',
      title: 'Hard & Heavy',
      artist: 'Rock Radio',
      sourceLabel: rock.name,
      color: rock.color,
      websiteUrl: rock.websiteUrl,
    },
    listeners: [{ id: '1', name: 'Vojta' }],
    voiceChannelName: 'kitchen',
    joinsToday: 1,
  };
}

function track(title: string, thumbnail?: string): Track {
  return {
    title,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    durationSec: 200,
    thumbnail,
    requestedBy: 'Vojta',
    requestedById: '42',
    uploader: 'Artist',
    source: 'youtube',
  };
}

function steamItem(n: number): SteamDealItem {
  return {
    id: String(1000 + n),
    title: `Game ${n}`,
    gameName:
      n === 3 ? `Game [${n}] with a very long name that keeps going and going on` : `Game ${n}`,
    link: `https://store.steampowered.com/app/${1000 + n}/Game_${n}/`,
    discount: '-90%',
    salePrice: '5,99€',
    originalPrice: '59,99€',
  };
}

function review(scoreDesc: string, score: number): SteamReviewInfo {
  return { score, scoreDesc, totalReviews: 50_000, positivePct: score >= 8 ? 92 : 55 };
}

/* ---------- Kitchen Board ---------- */

{
  const quiet = checkEmbedCard('kitchen-quiet', () => buildKitchenBoardDisplay(quietView()), [
    'The Kitchen',
    'Nothing on',
    'In voice',
    'Joined today',
    'The shelf is clear',
    'Nothing free this week',
    'attachment://kitchen-thumb.jpg',
  ]);
  if (quiet.includes('radio:catch') || quiet.includes('kitchen:catch-play')) {
    fail('kitchen-quiet-buttons', 'quiet board grew radio buttons');
  } else ok('kitchen-quiet-buttons', 'a quiet board has no buttons');
  const recovered = buildKitchenBoardDisplay(quietView());
  if ((recovered.files?.length ?? 0) !== 1) fail('kitchen-thumb', 'kitchen photo not attached');
  else ok('kitchen-thumb', 'kitchen photo attached once');
  if (!looksLikeKitchenBoard(messageText(recovered))) {
    fail('kitchen-recover', 'the posted board would not be found again');
  } else ok('kitchen-recover', 'the posted board is found again');
}

{
  const json = checkEmbedCard('kitchen-rock', () => buildKitchenBoardDisplay(rockView()), [
    '● Live · Rock Radio',
    'Rock Radio — Hard & Heavy',
    'radio:stop',
    'radio:catch',
    'Website',
  ]);
  if (json.includes('kitchen:catch-play')) {
    fail('kitchen-rock-play', 'Play does not belong on a board with no catch');
  } else ok('kitchen-rock-play', 'no Play without a catch');
  const order = ['radio:stop', 'Website', 'radio:catch'].map((needle) => json.indexOf(needle));
  if (order.some((at, i) => i > 0 && at < order[i - 1]!)) {
    fail('kitchen-rock-order', 'radio buttons are not Stop, Website, Catch');
  } else ok('kitchen-rock-order', 'Stop, Website, Catch as on the website');
}

checkEmbedCard(
  'kitchen-music',
  () =>
    buildKitchenBoardDisplay({
      ...quietView(),
      voiceChannelName: 'kitchen',
      listeners: [{ id: '1', name: 'Vojta' }],
      stereo: {
        kind: 'music',
        title: 'Song',
        artist: 'Artist',
        sourceLabel: 'YouTube',
        titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        color: 0xff0000,
        paused: true,
      },
    }),
  ['⏸️ Paused · YouTube', '"title":"Song"'],
);

{
  const rock = STATIONS.rock;
  const json = checkEmbedCard(
    'kitchen-full',
    () =>
      buildKitchenBoardDisplay({
        ...rockView(),
        joinsToday: 3,
        listeners: Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `Person ${i}` })),
        steam: {
          title: 'Hades',
          line: '−50% · 9,99€',
          url: 'https://store.steampowered.com/app/1145360',
        },
        epic: {
          title: 'Cocoon',
          line: 'Free this week',
          url: 'https://store.epicgames.com/en-US/p/cocoon',
        },
        radioNight: { stationName: 'Kiss Radio' },
        radioVote: { counts: { kiss: 2, rock: 5, beat: 1 }, total: 8 },
        latestCatch: { userId: '9', title: 'Caught Song', artist: 'Caught Artist', by: 'Vojta' },
        stereo: {
          kind: 'radio',
          title: 'Song',
          artist: 'Artist',
          sourceLabel: rock.name,
          color: rock.color,
          websiteUrl: rock.websiteUrl,
        },
      }),
    [
      '"value":"9"',
      '[Hades](https://store.steampowered.com/app/1145360) · −50% · 9,99€',
      'Cocoon',
      'Free this week',
      'Radio Night',
      'Latest catch',
      '🌙 Kitchen Board · Radio Night',
      'Tonight at 20:00. Pick the station.',
      'One vote each. You can change it.',
      'kitchen:vote:rock',
      'kitchen:catch-play',
      'radio:catch',
    ],
  );
  if (!json.includes('▰')) fail('kitchen-tally', 'the vote card has no tally bars');
  else ok('kitchen-tally', 'the vote card draws a tally');
}

if (!looksLikeKitchenBoard('**Quiet** · The Kitchen\n### Oven’s off\n-# Jar’s full')) {
  fail('kitchen-legacy', 'an old board would not be found and replaced');
} else ok('kitchen-legacy', 'an old board is still found, so it gets replaced');
if (
  looksLikeKitchenBoard('### This week\n**Caught**\n**Song** — Artist\n-# The Kitchen · this week')
) {
  fail('kitchen-chart', 'Sunday chart matched the living board');
} else ok('kitchen-chart', 'Sunday chart stays separate');

{
  const rock = rockView();
  const kiss = STATIONS.kiss;
  const switched: KitchenBoardView = {
    ...rock,
    stereo: { ...rock.stereo, sourceLabel: kiss.name, color: kiss.color },
  };
  if (kitchenViewKey(rock) === kitchenViewKey(switched)) {
    fail('kitchen-key-station', 'a station switch with the same title would not redraw');
  } else ok('kitchen-key-station', 'a station switch redraws the board');

  const epic = { title: 'Game', line: 'Coming next' };
  const before = kitchenViewKey({ ...quietView(), epic });
  const after = kitchenViewKey({ ...quietView(), epic: { ...epic, line: 'Free this week' } });
  if (before === after) fail('kitchen-key-epic', 'Epic going free would not redraw');
  else ok('kitchen-key-epic', 'Epic going free redraws the board');

  if (kitchenViewKey(rockView()) !== kitchenViewKey(rockView())) {
    fail('kitchen-key-stable', 'the same view produced two keys');
  } else ok('kitchen-key-stable', 'the same view keeps one key');
}

/* ---------- Steam ---------- */

{
  const items = Array.from({ length: 10 }, (_, i) => steamItem(i + 1));
  const prices = new Map(items.map((item) => [item.id, '~~59,99€~~ → **5,99€** (-90%)']));
  const reviews = new Map<string, SteamReviewInfo | null>(
    items.map((item, i) => [
      item.id,
      i < 6 ? review('Very Positive', 8) : i < 8 ? review('Mixed', 5) : null,
    ]),
  );
  const build = () => buildSteamDealsDisplay(items, prices, reviews);
  const json = checkEmbedCard('steam-digest-10', build, [
    'Steam · ',
    'Steam Daily Deals',
    '10 games · prices in €',
    '1. [Game 1](https://store.steampowered.com/app/1001/Game_1/) · Very Positive · `−90%` ~~59,99€~~ **5,99€**',
    '· Special ·',
    'Browse specials',
  ]);
  if (json.includes('Mixed')) fail('steam-chip', 'a Mixed game was labelled Mixed, not Special');
  else ok('steam-chip', 'well-reviewed games show their label, the rest show Special');

  const text = messageText(build());
  const titles = extractSteamDigestTitles(text);
  const expected = items.map(steamDealTitle);
  if (!looksLikeSteamDigest(text) || titles.join('|') !== expected.join('|')) {
    fail('steam-duplicate', `read back ${titles.length} titles: ${titles.join(' | ')}`);
  } else ok('steam-duplicate', 'a reposted digest reads back the same 10 titles');
}

checkEmbedCard('steam-empty', () => buildSteamDealsDisplay([], new Map()), [
  'The shelf is empty right now.',
]);

/* ---------- Epic ---------- */

{
  const soon = Date.now() + 3 * 86_400_000;
  const game = (title: string, isUpcoming: boolean): EpicFreeGame => ({
    title,
    description: 'A <b>cozy</b> puzzle game about [worlds] inside worlds.',
    originalPrice: '€19.99',
    storeUrl: `https://store.epicgames.com/en-US/p/${title.toLowerCase()}`,
    image: `https://cdn.example.com/${title}.jpg`,
    heroImage: `https://cdn.example.com/${title}-wide.jpg`,
    endDate: new Date(soon).toISOString(),
    isUpcoming,
    upcomingStartDate: isUpcoming ? new Date(soon).toISOString() : undefined,
  });
  const games = [game('Cocoon', false), game('Tunic', false), game('Hades', true)];
  const build = () => buildEpicFreeGamesDisplay(games);
  checkEmbedCard('epic-free-and-soon', build, [
    'Epic Games Store',
    '"title":"Free now"',
    '**[Cocoon](https://store.epicgames.com/en-US/p/cocoon)** · ~~€19.99~~ **Free** · ends <t:',
    'Coming next',
    'Yours to keep once claimed',
    'Cocoon-wide.jpg',
    'Claim Cocoon',
    'Browse free games',
  ]);
  const text = messageText(build());
  const titles = extractEpicTitles(text);
  const expected = selectEpicLineup(games).map(epicGameTitle);
  if (!looksLikeEpicDigest(text) || titles.join('|') !== expected.join('|')) {
    fail('epic-duplicate', `read back ${titles.join(' | ')}`);
  } else ok('epic-duplicate', 'a reposted lineup reads back the same titles');

  checkEmbedCard('epic-soon-only', () => buildEpicFreeGamesDisplay([game('Hades', true)]), [
    '"title":"Coming soon"',
    'Nothing free right now.',
  ]);
  checkEmbedCard('epic-empty', () => buildEpicFreeGamesDisplay([]), [
    'No free games listed right now.',
  ]);
}

/* ---------- Music ---------- */

{
  const nowArt = track('Now', 'https://cdn.example.com/now.jpg');
  const json = checkEmbedCard(
    'now-playing-full',
    () =>
      buildNowPlayingDisplay({
        track: nowArt,
        queueLength: 3,
        paused: false,
        loopMode: 'queue',
        positionSec: 42,
        volume: 1.25,
        hasHistory: true,
      }),
    [
      '🔊 Now Playing',
      'Requested by <@42> · YouTube',
      '`0:42`',
      '`3:20`',
      '3 up next · Volume 125%',
      'https://cdn.example.com/now.jpg',
    ],
  );
  const ids = ['music:pause', 'music:skip', 'music:stop', 'music:loop', 'music:shuffle'];
  const ids2 = ['music:prev', 'music:voldown', 'music:volup', 'music:queue'];
  const missing = [...ids, ...ids2].filter((id) => !json.includes(`"${id}"`));
  if (missing.length > 0) fail('now-playing-buttons', `missing ${missing.join(', ')}`);
  else ok('now-playing-buttons', 'transport row, then previous, volume, and queue');

  checkEmbedCard(
    'now-playing-paused',
    () =>
      buildNowPlayingDisplay({
        track: track('Now'),
        queueLength: 0,
        paused: true,
        loopMode: 'off',
      }),
    ['⏸️ Paused', 'Nothing up next', 'music:resume'],
  );

  const fresh = JSON.stringify(
    buildNowPlayingDisplay({
      track: nowArt,
      queueLength: 0,
      paused: false,
      loopMode: 'off',
    }).components.map((row) => row.toJSON()),
  );
  if (
    !/"custom_id":"music:prev"[^}]*"disabled":true|"disabled":true[^}]*"custom_id":"music:prev"/.test(
      fresh,
    )
  ) {
    fail('now-playing-prev-disabled', 'Previous is clickable with no history');
  } else ok('now-playing-prev-disabled', 'Previous waits for a finished track');
}

{
  // The player keeps the current track in its queue; the card leaves that one out.
  const now = track('Now');
  checkEmbedCard(
    'queue-card',
    () =>
      buildQueueDisplay(now, [now, ...Array.from({ length: 12 }, (_, i) => track(`T${i + 1}`))]),
    ['📜 Queue', 'Now: **[Now]', '1. [T1]', 'Page 1 of 2 · 12 up next', '◀ Prev', 'Next ▶'],
  );
  checkEmbedCard('queue-empty-after', () => buildQueueDisplay(now, [now]), ['– Nothing up next']);
}

/* ---------- Radio ---------- */

checkEmbedCard(
  'radio-live',
  () =>
    buildRadioPlayingDisplay(STATIONS.beat, {
      track: { artist: 'Example Artist', title: 'Example Song' },
    }),
  [
    '● Live · Radio Beat',
    'Example Artist — Example Song',
    'První bigbít u nás',
    'Edits itself when the song on air changes',
    'radio:stop',
    'radio:catch',
  ],
);
checkEmbedCard('radio-no-song', () => buildRadioPlayingDisplay(STATIONS.kiss), [
  '"title":"Live stream"',
]);

checkEmbedCard(
  'site-embed-fields',
  () => ({
    embeds: [
      buildSiteEmbed({
        color: 0xf5c400,
        author: '🌙 Radio Night',
        title: 'On the calendar',
        fields: [
          ['When', 'Friday 20:00 (Prague)'],
          ['Empty', '  '],
          ['Vote', 'Opens Friday 12:00 on the Kitchen Board', true],
        ],
      }),
    ],
    components: [],
  }),
  ['"inline":true', '"inline":false'],
);

/* ---------- /help (Components V2) ---------- */

{
  const commandsJson = commandList.map((command) => command.data.toJSON());
  const avatarUrl = 'https://cdn.example.com/avatar.png';
  checkCard('help-all', () => buildHelpDisplay(commandsJson, { avatarUrl }));
  checkCard('help-setup', () => buildHelpDisplay(commandsJson, { avatarUrl, focus: 'setup' }));
  checkCard('help-play', () => buildHelpDisplay(commandsJson, { focus: 'play' }));

  const helpJson = (display: { components: { toJSON: () => unknown }[] }): string =>
    JSON.stringify(display.components.map((component) => component.toJSON()));
  const all = helpJson(buildHelpDisplay(commandsJson, { avatarUrl }));
  const unlisted = commandsJson.filter((command) => !all.includes(`/${command.name}`));
  if (unlisted.length > 0) {
    fail('help-lists-all', `missing ${unlisted.map((command) => command.name).join(', ')}`);
  } else ok('help-lists-all', `all ${commandsJson.length} commands listed`);
  if (all.includes('🧩 Other')) fail('help-shelves', 'a command has no shelf in /help');
  else ok('help-shelves', 'every command sits on a named shelf');

  const play = helpJson(buildHelpDisplay(commandsJson, { focus: 'play' }));
  if (!play.includes('`query`') || !play.includes('`play_next`')) {
    fail('help-play-options', '/help command:play does not list its options');
  } else ok('help-play-options', '/help command:play lists query and play_next');
}

if (failed > 0) {
  console.error(`${failed} card check(s) failed`);
  process.exit(1);
}
