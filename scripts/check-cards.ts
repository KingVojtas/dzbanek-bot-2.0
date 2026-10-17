/**
 * Serializes the Kitchen Board, the queue card, and a 10-game Steam digest.
 * A section without a thumbnail or button throws. Discord also rejects a
 * message whose nested components exceed 40.
 */
import { formatSaleEnd, buildQueueDisplay, buildSteamDealsDisplay } from '../src/core/display';
import type { SteamDealItem, Track } from '../src/core/types';
import { buildKitchenBoardDisplay, type KitchenBoardView } from '../src/kitchen/display';
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

function quietView(): KitchenBoardView {
  return {
    stereo: {
      kind: 'quiet',
      title: 'Oven’s off',
      artist: 'Drop /radio play or /play and I’ll put the kettle on.',
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
      detail: rock.slogan,
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

checkCard('kitchen-quiet', () => buildKitchenBoardDisplay(quietView()));
checkCard('kitchen-rock', () => {
  const display = buildKitchenBoardDisplay(rockView());
  const json = JSON.stringify(display.components.map((component) => component.toJSON()));
  if (!json.includes(STATIONS.rock.logoUrl)) {
    throw new Error('Rock logo missing from the board');
  }
  return display;
});
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

if (failed > 0) {
  console.error(`${failed} card check(s) failed`);
  process.exit(1);
}
