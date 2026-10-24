import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SteamDealItem } from '../src/core/types';
import type { SteamReviewInfo } from '../src/deals/steam/SteamReviewApi';
import {
  isSteamFloorPrice,
  selectSteamDigest,
  steamDigestFingerprint,
  uniqueSteamApps,
} from '../src/deals/steam/select-digest';

function deal(id: string, discount: number, extra: Partial<SteamDealItem> = {}): SteamDealItem {
  return {
    id,
    title: id,
    gameName: id,
    link: `https://store.steampowered.com/app/${id}/`,
    discount: `-${discount}%`,
    salePrice: '9,99€',
    ...extra,
  };
}

const good: SteamReviewInfo = {
  score: 8,
  scoreDesc: 'Very Positive',
  totalReviews: 500,
  positivePct: 90,
};
const meh: SteamReviewInfo = { score: 5, scoreDesc: 'Mixed', totalReviews: 500, positivePct: 55 };

describe('selectSteamDigest', () => {
  it('puts good blockbusters, then blockbusters, then good reviews, then the rest', () => {
    const items = [
      deal('1', 90),
      deal('2', 20, { blockbuster: true }),
      deal('3', 50),
      deal('4', 30, { blockbuster: true }),
    ];
    const reviews = new Map([
      ['1', meh],
      ['2', good],
      ['3', good],
      ['4', meh],
    ]);
    assert.deepEqual(
      selectSteamDigest(items, reviews, 10).map((item) => item.id),
      ['2', '4', '3', '1'],
    );
  });

  it('orders by deepest discount inside a group, then review count', () => {
    const items = [deal('a', 50), deal('b', 75), deal('c', 50)];
    const reviews = new Map<string, SteamReviewInfo | null>([
      ['a', { ...good, totalReviews: 100 }],
      ['b', good],
      ['c', { ...good, totalReviews: 9_000 }],
    ]);
    assert.deepEqual(
      selectSteamDigest(items, reviews, 10).map((item) => item.id),
      ['b', 'c', 'a'],
    );
  });

  it('stops at the requested size and never repeats a game', () => {
    const items = Array.from({ length: 15 }, (_, i) => deal(String(i), 10 + i));
    const picked = selectSteamDigest(items, new Map(), 10);
    assert.equal(picked.length, 10);
    assert.equal(new Set(picked.map((item) => item.id)).size, 10);
  });

  it('returns nothing for size 0', () => {
    assert.deepEqual(selectSteamDigest([deal('a', 50)], new Map(), 0), []);
  });
});

describe('uniqueSteamApps', () => {
  it('keeps one row per app and borrows the better image and tags', () => {
    const rss = deal('x', 50, {
      link: 'https://store.steampowered.com/app/1245620/ELDEN_RING/',
      image: 'https://cdn/library_600x900.jpg',
    });
    const search = deal('x-search', 50, {
      link: rss.link,
      image: 'https://cdn/store_item_assets/capsule.jpg',
      tagIds: [19],
      released: '1 Jan, 2020',
    });
    const out = uniqueSteamApps([rss, search]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, 'x');
    assert.equal(out[0]!.image, search.image);
    assert.deepEqual(out[0]!.tagIds, [19]);
    assert.equal(out[0]!.released, '1 Jan, 2020');
  });
});

describe('isSteamFloorPrice', () => {
  it('flags the 0,49 € floor and below', () => {
    assert.equal(isSteamFloorPrice(deal('a', 90, { salePrice: '0,49€' })), true);
    assert.equal(isSteamFloorPrice(deal('a', 90, { salePrice: '0.19 €' })), true);
    assert.equal(isSteamFloorPrice(deal('a', 90, { salePrice: '0,50€' })), false);
    assert.equal(isSteamFloorPrice(deal('a', 90, { salePrice: undefined })), false);
  });
});

describe('steamDigestFingerprint', () => {
  it('depends on the lineup and its order', () => {
    const a = [deal('1', 50), deal('2', 50)];
    assert.equal(steamDigestFingerprint(a), steamDigestFingerprint([...a]));
    assert.notEqual(steamDigestFingerprint(a), steamDigestFingerprint([...a].reverse()));
  });
});
