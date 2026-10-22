/**
 * Serializes every card the bot posts. Music and radio are classic embeds:
 * Discord rejects an embed past its text limits and a row with more than five
 * buttons. The Kitchen Board, Steam, Epic, the Sunday postcard, and /help are
 * Components V2: a section without a thumbnail or button throws, and a message
 * may hold at most 40 components and 4000 characters of text.
 */
import { MessageFlags } from 'discord.js';
import { commandList } from '../src/commands';
import { buildHelpDisplay } from '../src/commands/help';
import {
  EPIC_SHELF_MARKER,
  STEAM_SHELF_MARKER,
  V2_COMPONENT_MAX,
  V2_TEXT_MAX,
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
  v2TextLength,
  type V2Display,
} from '../src/core/display';
import { buildSiteEmbed, type EmbedCard } from '../src/core/embeds';
import type { EpicFreeGame, SteamDealItem, Track } from '../src/core/types';
import type { SteamReviewInfo } from '../src/deals/steam/SteamReviewApi';
import { buildKitchenChartDisplay } from '../src/kitchen/chart';
import {
  KITCHEN_BUTTON_SUFFIX,
  buildKitchenBoardDisplay,
  kitchenViewKey,
  looksLikeKitchenBoard,
  type KitchenBoardView,
} from '../src/kitchen/display';
import { buildRadioPlayingDisplay } from '../src/radio/embed';
import { STATIONS } from '../src/radio/station';

const ACTION_ROW = 1;
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

/** Components V2 card: both of Discord's caps, sections with an accessory, sane button rows. */
function checkV2(
  name: string,
  build: () => V2Display & { files?: unknown[] },
  wants: string[] = [],
): string {
  let display: V2Display;
  try {
    display = build();
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
    return '';
  }
  const json = display.components.map((component) => component.toJSON());
  const nodes: JsonNode[] = [];
  collect(json, nodes);
  const text = JSON.stringify(json);
  const chars = v2TextLength(display.components);
  const problems: string[] = [];
  if (display.flags !== MessageFlags.IsComponentsV2) problems.push('not flagged as Components V2');
  if (nodes.length > V2_COMPONENT_MAX) problems.push(`${nodes.length} components (max 40)`);
  if (chars > V2_TEXT_MAX) problems.push(`${chars} characters of text (max ${V2_TEXT_MAX})`);
  const bare = nodes.filter(
    (node) =>
      node.type === SECTION &&
      node.accessory?.type !== THUMBNAIL &&
      node.accessory?.type !== BUTTON,
  );
  if (bare.length > 0) problems.push(`${bare.length} section(s) without a thumbnail or button`);
  const rows = nodes.filter((node) => node.type === ACTION_ROW) as Array<
    JsonNode & { components?: unknown[] }
  >;
  if (rows.some((row) => !row.components?.length || row.components.length > 5)) {
    problems.push('a button row with 0 or more than 5 buttons');
  }
  const missing = wants.filter((want) => !text.includes(want));
  if (missing.length > 0) problems.push(`missing ${missing.join(' | ')}`);
  if (problems.length > 0) {
    fail(name, problems.join('; '));
    return text;
  }
  ok(name, `${display.components.length} card(s), ${nodes.length} components, ${chars} characters`);
  return text;
}

/** The text a duplicate check would see on the posted message. */
function v2MessageText(display: V2Display): string {
  return collectMessageTextContent({ components: display.components });
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
      tagline: rock.slogan,
      logoUrl: rock.logoUrl,
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
    image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${1000 + n}/library_600x900.jpg`,
    heroImage:
      n === 1
        ? 'https://cdn.akamai.steamstatic.com/steam/apps/1001/capsule_616x353.jpg'
        : undefined,
    tags: 'Action · Adventure · Open World · Story Rich',
    expires: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    description:
      n === 1
        ? 'Winner of over 175 Game of the Year Awards and recipient of over 250 perfect scores, an epic tale of honor and loyalty at the dawn of the modern age.'
        : undefined,
  };
}

function review(scoreDesc: string, score: number): SteamReviewInfo {
  return { score, scoreDesc, totalReviews: 650_000, positivePct: score >= 8 ? 92 : 55 };
}

/* ---------- Kitchen Board ---------- */

{
  const quiet = checkV2('kitchen-quiet', () => buildKitchenBoardDisplay(quietView()), [
    '🍪 The Kitchen',
    'The Pantry',
    'Kitchen Board',
    'the shelf is clear',
    'nothing free this week',
    'attachment://kitchen-hero.jpg',
  ]);
  if (quiet.includes('radio:catch') || quiet.includes('kitchen:catch-play')) {
    fail('kitchen-quiet-buttons', 'quiet board grew radio buttons');
  } else ok('kitchen-quiet-buttons', 'a quiet board has no buttons');
  const recovered = buildKitchenBoardDisplay(quietView());
  if (recovered.files.length !== 1) fail('kitchen-photo', 'kitchen photo not attached once');
  else ok('kitchen-photo', 'kitchen photo attached once');
  if (!looksLikeKitchenBoard(v2MessageText(recovered))) {
    fail('kitchen-recover', 'the posted board would not be found again');
  } else ok('kitchen-recover', 'the posted board is found again');
  if (buildKitchenBoardDisplay(rockView()).files.length !== 0) {
    fail('kitchen-no-stray-files', 'a live board uploads a photo it does not show');
  } else ok('kitchen-no-stray-files', 'a live board uploads nothing it does not show');
}

{
  const json = checkV2('kitchen-rock', () => buildKitchenBoardDisplay(rockView()), [
    '🔴 LIVE · [Rock Radio](https://rockovyradio.cz/)',
    'Rock je slušná muzika',
    '## Hard & Heavy',
    '**Rock Radio**',
    '🎧 **kitchen** · 1 listening',
    'radio:stop',
    'radio:catch',
    'Website',
    'img-social-networks-default.jpg',
  ]);
  if (json.includes('kitchen:catch-play')) {
    fail('kitchen-rock-play', 'Play does not belong on a board with no catch');
  } else ok('kitchen-rock-play', 'no Play without a catch');
}

{
  const json = checkV2(
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
          artUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          durationSec: 213,
          queueLength: 4,
          requestedBy: 'Vojta',
        },
      }),
    [
      '⏸️ PAUSED · YouTube',
      '## [Song](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
      '**Artist** · `3:33`',
      '📜 4 up next',
      'hqdefault.jpg',
      `music:resume${KITCHEN_BUTTON_SUFFIX}`,
      `music:skip${KITCHEN_BUTTON_SUFFIX}`,
      `music:stop${KITCHEN_BUTTON_SUFFIX}`,
      '"music:queue"',
    ],
  );
  if (json.includes('"music:resume"') || json.includes('"music:pause"')) {
    fail('kitchen-music-ids', 'a board button would turn the board into a Now Playing card');
  } else ok('kitchen-music-ids', 'board controls carry the board suffix');
}

{
  const rock = STATIONS.rock;
  const json = checkV2(
    'kitchen-full',
    () =>
      buildKitchenBoardDisplay({
        ...rockView(),
        joinsToday: 3,
        listeners: Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `Person ${i}` })),
        steam: {
          kicker: '💸 STEAM DEAL OF THE DAY',
          title: 'Hades',
          line: '`−50%` ~~19,99€~~ → **9,99€** · you save 10,00€',
          note: '🏆 Overwhelmingly Positive · 98% of 250K · +9 more in <#123>',
          url: 'https://store.steampowered.com/app/1145360',
          image: 'https://cdn.example.com/hades.jpg',
        },
        epic: {
          kicker: '🎁 FREE ON EPIC THIS WEEK',
          title: 'Cocoon',
          line: '**🆓 FREE** ~~$24.99~~ · ⏳ ends <t:1900000000:R>',
          url: 'https://store.epicgames.com/en-US/p/cocoon',
        },
        radioNight: { stationName: 'Kiss Radio', channelName: 'kitchen' },
        radioVote: { counts: { kiss: 2, rock: 5, beat: 1 }, total: 8, closesAt: 1_900_000_000 },
        latestCatch: {
          userId: '9',
          title: 'Caught Song',
          artist: 'Caught Artist',
          by: 'Vojta',
          stationName: 'Kiss Radio',
        },
        stereo: {
          kind: 'radio',
          title: 'Song',
          artist: 'Artist',
          sourceLabel: rock.name,
          color: rock.color,
          websiteUrl: rock.websiteUrl,
          artUrl: 'https://cdn.example.com/cover.jpg',
        },
      }),
    [
      '9 listening',
      '· +1',
      '### [Hades](https://store.steampowered.com/app/1145360)',
      '+9 more in <#123>',
      'Cocoon',
      '🍪 **3** cookies out of the jar today',
      '🌙 Radio Night · voting closes <t:1900000000:R>',
      '**5** 👑',
      '🎣 LATEST CATCH · off Kiss Radio',
      'attachment://kitchen-thumb.jpg',
      'kitchen:vote:rock',
      'Rock · 5',
      'kitchen:catch-play',
      'radio:catch',
      'cover.jpg',
    ],
  );
  if (!json.includes('▰')) fail('kitchen-tally', 'the vote has no tally bars');
  else ok('kitchen-tally', 'the vote draws a tally');
  if (json.includes('Radio Night** · Friday 20:00')) {
    fail('kitchen-night-twice', 'Radio Night is listed twice while the vote is open');
  } else ok('kitchen-night-twice', 'the open vote replaces the Radio Night line');
}

{
  const tie = JSON.stringify(
    buildKitchenBoardDisplay({
      ...quietView(),
      radioVote: { counts: { kiss: 2, rock: 2, beat: 0 }, total: 4 },
    }).components.map((c) => c.toJSON()),
  );
  if (tie.includes('👑')) fail('kitchen-tie', 'a tied vote crowned a leader');
  else ok('kitchen-tie', 'a tie crowns nobody');
}

if (!looksLikeKitchenBoard('**Quiet** · The Kitchen\n### Oven’s off\n-# Jar’s full')) {
  fail('kitchen-legacy', 'an old board would not be found and replaced');
} else ok('kitchen-legacy', 'an old board is still found, so it gets replaced');

{
  const postcard = buildKitchenChartDisplay({
    weekLabel: '19–25 Oct',
    songs: [
      { title: 'Song', artist: 'Artist', names: ['Vojta', 'Anna'] },
      { title: 'Other', artist: 'Band', names: ['Petr'] },
    ],
    night: { counts: { kiss: 1, rock: 4, beat: 2 }, winnerName: 'Rock Radio' },
  });
  checkV2('kitchen-postcard', () => postcard, [
    '📬 The week in the kitchen',
    '🥇 **Song** — Artist',
    'caught 2×',
    '🏆 **Rock Radio** took the night',
    'attachment://kitchen-hero.jpg',
  ]);
  const empty = buildKitchenChartDisplay({ weekLabel: '19–25 Oct', songs: [] });
  if (
    looksLikeKitchenBoard(v2MessageText(postcard)) ||
    looksLikeKitchenBoard(v2MessageText(empty))
  ) {
    fail('kitchen-chart', 'the Sunday postcard matched the living board');
  } else ok('kitchen-chart', 'the Sunday postcard stays separate');
}

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

  const epic = { kicker: 'Epic', title: 'Game', line: 'Coming next' };
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
  const json = checkV2('steam-digest-10', build, [
    '## 💸 [Steam Daily Deals]',
    'the 10 best discounts on Steam today',
    '### 🥇 [Game 1](https://store.steampowered.com/app/1001/Game_1/)',
    '### 4 · [Game 4]',
    '`−90%` ~~59,99€~~ → **5,99€** · you save 54,00€',
    '💎 Very Positive · 92% of 650K',
    'Action, Adventure, Open World',
    '⏳ ends <t:',
    '> Winner of over 175 Game of the Year Awards',
    'capsule_616x353.jpg',
    'All 10 together: **59,90€** instead of ~~599,90€~~',
    STEAM_SHELF_MARKER,
    'Browse all specials',
  ]);
  if (json.includes('Mixed')) fail('steam-chip', 'a Mixed game was labelled Mixed');
  else ok('steam-chip', 'only well-reviewed games wear a review label');

  const text = v2MessageText(build());
  const titles = extractSteamDigestTitles(text);
  const expected = items.map(steamDealTitle);
  if (!looksLikeSteamDigest(text) || titles.join('|') !== expected.join('|')) {
    fail('steam-duplicate', `read back ${titles.length} titles: ${titles.join(' | ')}`);
  } else ok('steam-duplicate', 'a reposted digest reads back the same 10 titles');

  // Worst case: long names, long tags, long prices. The card trims extras, never rows.
  const heavy = items.map((item, i) => ({
    ...item,
    gameName: `${'Very Long Collector Edition Title '.repeat(3)}${i}`,
    link: `${item.link}${'x'.repeat(80)}/`,
    tags: 'Massively Multiplayer · Psychological Horror · Character Customization · Story Rich',
  }));
  const heavyJson = checkV2('steam-digest-heavy', () =>
    buildSteamDealsDisplay(heavy, prices, reviews),
  );
  if (
    extractSteamDigestTitles(v2MessageText(buildSteamDealsDisplay(heavy, prices, reviews)))
      .length !== 10
  ) {
    fail('steam-heavy-rows', 'a heavy shelf lost rows');
  } else if (heavyJson) ok('steam-heavy-rows', 'a heavy shelf keeps all 10 rows');

  const bare = items.map((item) => ({ ...item, image: undefined, heroImage: undefined }));
  checkV2('steam-no-art', () => buildSteamDealsDisplay(bare, prices, reviews), ['"label":"Store"']);
}

checkV2('steam-empty', () => buildSteamDealsDisplay([], new Map()), [
  'The shelf is empty right now.',
  STEAM_SHELF_MARKER,
]);

/* ---------- Epic ---------- */

{
  const soon = Date.now() + 3 * 86_400_000;
  const game = (title: string, isUpcoming: boolean): EpicFreeGame => ({
    title,
    description: 'A <b>cozy</b> puzzle game about [worlds] inside worlds.',
    originalPrice: '$19.99',
    storeUrl: `https://store.epicgames.com/en-US/p/${title.toLowerCase()}`,
    image: `https://cdn.example.com/${title}.jpg`,
    heroImage: `https://cdn.example.com/${title}-wide.jpg`,
    seller: 'Annapurna',
    endDate: new Date(soon + (isUpcoming ? 7 * 86_400_000 : 0)).toISOString(),
    isUpcoming,
    upcomingStartDate: isUpcoming ? new Date(soon).toISOString() : undefined,
  });
  const games = [game('Cocoon', false), game('Tunic', false), game('Hades', true)];
  const build = () => buildEpicFreeGamesDisplay(games);
  checkV2('epic-free-and-soon', build, [
    '## 🎁 [Epic Free Games]',
    '2 free now · 1 coming next',
    '### [Cocoon](https://store.epicgames.com/en-US/p/cocoon)',
    '**🆓 FREE** ~~$19.99~~',
    '⏳ Free until <t:',
    '> A cozy puzzle game about worlds inside worlds.',
    '-# by Annapurna',
    'Cocoon-wide.jpg',
    '💰 **$39.98** worth of games',
    EPIC_SHELF_MARKER,
    '🔜 Coming next',
    '🔓 Free <t:',
    'Claim Cocoon',
    'Claim Tunic',
    'All free games',
  ]);
  const text = v2MessageText(build());
  const titles = extractEpicTitles(text);
  const expected = selectEpicLineup(games).map(epicGameTitle);
  if (!looksLikeEpicDigest(text) || titles.join('|') !== expected.join('|')) {
    fail('epic-duplicate', `read back ${titles.join(' | ')}`);
  } else ok('epic-duplicate', 'a reposted lineup reads back the same titles');

  const crowd = [
    ...Array.from({ length: 8 }, (_, i) => game(`Free${i}`, false)),
    ...Array.from({ length: 8 }, (_, i) => game(`Soon${i}`, true)),
  ];
  checkV2('epic-crowded', () => buildEpicFreeGamesDisplay(crowd));

  checkV2('epic-soon-only', () => buildEpicFreeGamesDisplay([game('Hades', true)]), [
    'Nothing free right now. The next drop unlocks <t:',
    EPIC_SHELF_MARKER,
  ]);
  checkV2('epic-empty', () => buildEpicFreeGamesDisplay([]), ['No free games listed right now.']);
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
