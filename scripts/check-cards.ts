/**
 * Serializes the Kitchen Board, the queue card, and a 10-game Steam digest.
 * A section without a thumbnail or button throws. Discord also rejects a
 * message whose nested components exceed 40.
 */
import { formatSaleEnd, buildQueueDisplay, buildSteamDealsDisplay } from '../src/core/display';
import type { SteamDealItem, Track } from '../src/core/types';
import {
  buildKitchenBoardDisplay,
  kitchenViewKey,
  looksLikeKitchenBoard,
  type KitchenBoardView,
} from '../src/kitchen/display';
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

function cardJson(display: { components: { toJSON: () => unknown }[] }): string {
  return JSON.stringify(display.components.map((component) => component.toJSON()));
}

function countOf(json: string, needle: string): number {
  return json.split(needle).length - 1;
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
    steamCount: 0,
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
      sourceUrl: rock.websiteUrl,
      heroUrl: rock.imageUrl,
      logoUrl: rock.logoUrl,
      color: rock.color,
      websiteUrl: rock.websiteUrl,
    },
    listeners: [{ id: '1', name: 'Vojta' }],
    voiceChannelName: 'kitchen',
    steamCount: 0,
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
    uploader: 'Artist',
    source: 'youtube',
  };
}

function steamItem(n: number): SteamDealItem {
  return {
    id: String(1000 + n),
    title: `Game ${n}`,
    gameName: `Game ${n}`,
    link: `https://store.steampowered.com/app/${1000 + n}`,
    discount: '50',
    salePrice: '€9.99',
    originalPrice: '€19.99',
    expires: '2026-10-19',
    released: '5 Dec, 2019',
    tags: 'Action, Adventure',
    image: `https://cdn.example.com/capsule/${n}.jpg`,
  };
}

const saleEnd = formatSaleEnd('2026-10-19');
if (saleEnd !== 'Ends 19 Oct') fail('sale-end', `got ${JSON.stringify(saleEnd)}`);
else ok('sale-end', saleEnd);

checkCard('kitchen-quiet', () => {
  const display = buildKitchenBoardDisplay(quietView());
  const json = cardJson(display);
  if (display.components.length !== 2)
    throw new Error(`expected 2 cards, got ${display.components.length}`);
  if ((display.files?.length ?? 0) < 2) throw new Error('quiet kitchen art missing');
  if (!json.includes('Nothing on.')) throw new Error('quiet copy missing');
  if (!json.includes('Steam') || !json.includes('Epic')) throw new Error('counter missing');
  if (json.includes('radio:catch') || json.includes('kitchen:catch-play')) {
    throw new Error('quiet board grew radio buttons');
  }
  if (!looksLikeKitchenBoard(json)) throw new Error('quiet board would not be recovered');
  return display;
});
checkCard('kitchen-rock', () => {
  const display = buildKitchenBoardDisplay(rockView());
  const json = cardJson(display);
  if (countOf(json, STATIONS.rock.logoUrl) !== 1) {
    throw new Error('Rock logo should be the thumbnail once');
  }
  if (json.includes(STATIONS.rock.slogan)) throw new Error('station slogan repeated on the board');
  if (!json.includes('radio:catch') || !json.includes('radio:stop')) {
    throw new Error('radio buttons missing from the stereo card');
  }
  if (json.includes('kitchen:catch-play'))
    throw new Error('Play does not belong on a board with no catch');
  if (!json.includes('cookie out of the jar'))
    throw new Error('join line missing from the room card');
  if (display.components.length !== 3)
    throw new Error(`expected 3 cards, got ${display.components.length}`);
  return display;
});
checkCard('kitchen-song-cover', () => {
  const rock = STATIONS.rock;
  const cover = 'https://cdn.example.com/cover.jpg';
  const display = buildKitchenBoardDisplay({
    ...rockView(),
    joinsToday: 0,
    stereo: {
      kind: 'radio',
      title: 'Song',
      artist: 'Artist',
      sourceLabel: rock.name,
      sourceUrl: rock.websiteUrl,
      heroUrl: cover,
      logoUrl: rock.logoUrl,
      color: rock.color,
      websiteUrl: rock.websiteUrl,
    },
  });
  const json = cardJson(display);
  if (!json.includes(cover) || !json.includes(rock.logoUrl)) {
    throw new Error('song cover and station mark should both show');
  }
  if (display.components.length !== 2) throw new Error('no room card when the room is quiet');
  return display;
});
checkCard('kitchen-music', () => {
  const display = buildKitchenBoardDisplay({
    ...quietView(),
    voiceChannelName: 'kitchen',
    listeners: [{ id: '1', name: 'Vojta' }],
    stereo: {
      kind: 'music',
      title: 'Song',
      artist: 'Artist',
      sourceLabel: 'YouTube',
      titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      heroUrl: 'https://cdn.example.com/thumb.jpg',
      color: 0xff0000,
      paused: true,
      queueLength: 2,
    },
  });
  const json = cardJson(display);
  if (!json.includes('Open') || !json.includes('Paused') || !json.includes('Queue')) {
    throw new Error('music card missing Open, Paused, or Queue');
  }
  if (json.includes('radio:catch')) throw new Error('Catch does not belong on a music card');
  return display;
});
checkCard('kitchen-room', () => {
  const display = buildKitchenBoardDisplay({
    ...quietView(),
    joinsToday: 2,
    radioNight: { stationName: 'Kiss Radio' },
    radioVote: { counts: { kiss: 1, rock: 4, beat: 0 }, total: 5 },
    latestCatch: {
      userId: '9',
      title: 'Caught Song',
      artist: 'Caught Artist',
      by: 'Vojta',
      coverUrl: 'https://cdn.example.com/catch.jpg',
    },
  });
  const json = cardJson(display);
  if (display.components.length !== 3) throw new Error('room card missing');
  if (!json.includes('kitchen:catch-play')) throw new Error('Play missing from the catch');
  if (!json.includes('kitchen:vote:rock')) throw new Error('vote buttons missing');
  if (!json.includes('Vojta') || !json.includes('Caught Song'))
    throw new Error('catch row missing');
  if (json.includes('radio:stop')) throw new Error('Stop does not belong on a quiet board');
  return display;
});
checkCard('kitchen-full', () => {
  const rock = STATIONS.rock;
  const display = buildKitchenBoardDisplay({
    ...rockView(),
    joinsToday: 3,
    listeners: Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `Person ${i}` })),
    steamCount: 10,
    steam: {
      title: 'Hades',
      kicker: 'Steam',
      line: '-50% · €9.99 · and 9 more',
      url: 'https://store.steampowered.com/app/1145360',
      image: 'https://cdn.example.com/hades.jpg',
    },
    epic: {
      title: 'Cocoon',
      kicker: 'Epic · Free now',
      line: '',
      url: 'https://store.epicgames.com/en-US/p/cocoon',
      image: 'https://cdn.example.com/cocoon.jpg',
    },
    radioVote: { counts: { kiss: 2, rock: 5, beat: 1 }, total: 8 },
    latestCatch: {
      userId: '9',
      title: 'Caught Song',
      artist: 'Caught Artist',
      by: 'Vojta',
      coverUrl: 'https://cdn.example.com/catch.jpg',
    },
    stereo: {
      kind: 'radio',
      title: 'Song',
      artist: 'Artist',
      sourceLabel: rock.name,
      sourceUrl: rock.websiteUrl,
      heroUrl: 'https://cdn.example.com/cover.jpg',
      logoUrl: rock.logoUrl,
      color: rock.color,
      websiteUrl: rock.websiteUrl,
    },
  });
  const json = cardJson(display);
  if (display.components.length !== 3) throw new Error('full board should be three cards');
  if (!json.includes('radio:catch') || !json.includes('kitchen:catch-play')) {
    throw new Error('Catch and Play split across cards');
  }
  if (!json.includes('+1')) throw new Error('ninth listener was not rolled into +1');
  return display;
});
if (!looksLikeKitchenBoard('**Quiet** · The Kitchen\n### Oven’s off\n-# Jar’s full')) {
  fail('kitchen-legacy', 'old board text would be abandoned');
} else ok('kitchen-legacy', 'old copy still matches');
if (
  looksLikeKitchenBoard('### This week\n**Caught**\n**Song** — Artist\n-# The Kitchen · this week')
) {
  fail('kitchen-chart', 'Sunday chart matched the living board');
} else ok('kitchen-chart', 'Sunday chart stays separate');
checkCard('kitchen-empty-cupboard', () =>
  buildKitchenBoardDisplay({
    ...quietView(),
    steam: undefined,
    epic: undefined,
  }),
);
checkCard('kitchen-steam-line', () => {
  const display = buildKitchenBoardDisplay({
    ...quietView(),
    steamCount: 2,
    steam: {
      title: 'Hades',
      kicker: 'STEAM · 50%',
      line: `€9.99 · Very Positive · ${saleEnd}`,
      url: 'https://store.steampowered.com/app/1145360',
      image: 'https://cdn.example.com/hades.jpg',
    },
  });
  const json = JSON.stringify(display.components.map((component) => component.toJSON()));
  if (!json.includes(saleEnd)) throw new Error('sale end missing from the board');
  return display;
});

checkCard('steam-digest-10', () =>
  buildSteamDealsDisplay(
    Array.from({ length: 10 }, (_, i) => steamItem(i + 1)),
    new Map(),
  ),
);

checkCard('queue-card', () =>
  buildQueueDisplay(track('Now', 'https://cdn.example.com/now.jpg'), [
    track('Now', 'https://cdn.example.com/now.jpg'),
    track('Next'),
    track('Later'),
  ]),
);
checkCard('queue-no-art', () => buildQueueDisplay(track('Now'), [track('Now'), track('Next')]));

{
  const rock = rockView();
  const kiss = STATIONS.kiss;
  const switched: KitchenBoardView = {
    ...rock,
    stereo: {
      ...rock.stereo,
      sourceLabel: kiss.name,
      sourceUrl: kiss.websiteUrl,
      logoUrl: kiss.logoUrl,
      color: kiss.color,
      websiteUrl: kiss.websiteUrl,
    },
  };
  if (kitchenViewKey(rock) === kitchenViewKey(switched)) {
    fail('kitchen-key-station', 'a station switch with the same title would not redraw');
  } else ok('kitchen-key-station', 'a station switch redraws the board');

  const epic = { title: 'Game', kicker: 'Epic · Coming next', line: '' };
  const before = kitchenViewKey({ ...quietView(), epic });
  const after = kitchenViewKey({ ...quietView(), epic: { ...epic, kicker: 'Epic · Free now' } });
  if (before === after) fail('kitchen-key-epic', 'Epic going free would not redraw');
  else ok('kitchen-key-epic', 'Epic going free redraws the board');

  if (kitchenViewKey(rockView()) !== kitchenViewKey(rockView())) {
    fail('kitchen-key-stable', 'the same view produced two keys');
  } else ok('kitchen-key-stable', 'the same view keeps one key');
}

if (failed > 0) {
  console.error(`${failed} card check(s) failed`);
  process.exit(1);
}
