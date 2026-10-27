import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import { pickSong, type FmSong } from '../src/fm/script';
import { genreSongs } from '../src/fm/taste';
import {
  playFromFire,
  tallyReactions,
  toggleReaction,
  type ReactionRow,
} from '../src/fm/reactions';

function row(userId: string, kind: 'fire' | 'nope', songKey = 'sheen|lavazza'): ReactionRow {
  return {
    userId,
    songKey,
    url: 'https://youtu.be/lavazza',
    title: 'Lavazza',
    artist: 'Viktor Sheen',
    kind,
  };
}

const find: Track = {
  title: 'Viktor Sheen - Lavazza',
  url: 'https://youtu.be/lavazza',
  durationSec: 180,
  thumbnail: 'https://cdn.example/lav.jpg',
  uploader: 'Viktor Sheen',
  requestedBy: 'Kitchen FM',
};

function kitchen(key: string, heat = 0, nopes = 0): FmSong {
  return {
    key,
    artist: 'Artist',
    title: key,
    label: `Artist — ${key}`,
    query: `Artist - ${key}`,
    durationSec: 180,
    from: { kind: 'play', userId: 'fan' },
    at: new Date('2026-10-01T00:00:00Z'),
    heat,
    nopes,
  };
}

/** A seeded RNG in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('song reactions', () => {
  it('takes a reaction back and switches the other way', () => {
    const first = toggleReaction([], 'u1', row('u1', 'fire'), 'fire');
    assert.equal(first.result.kind, 'fire');
    assert.equal(first.result.fires, 1);
    assert.equal(first.result.firstFire, true);

    const back = toggleReaction(first.rows, 'u1', row('u1', 'fire'), 'fire');
    assert.equal(back.result.kind, null);
    assert.equal(back.result.fires, 0);
    assert.equal(back.result.firstFire, false);

    const nope = toggleReaction(first.rows, 'u1', row('u1', 'nope'), 'nope');
    assert.equal(nope.result.kind, 'nope');
    assert.equal(nope.result.fires, 0);
    assert.equal(nope.result.nopes, 1);
    assert.equal(nope.result.firstFire, false);

    const switched = toggleReaction(nope.rows, 'u1', row('u1', 'fire'), 'fire');
    assert.equal(switched.result.kind, 'fire');
    assert.equal(switched.result.fires, 1);
    assert.equal(switched.result.nopes, 0);
    assert.equal(switched.result.firstFire, true);

    const second = toggleReaction(switched.rows, 'u2', row('u2', 'fire'), 'fire');
    assert.equal(second.result.fires, 2);
    assert.equal(second.result.firstFire, false);
  });

  it('records a 🔥 on a new find for the first person only', () => {
    const credited = playFromFire(find, 'u1', false, true);
    assert.equal(credited?.requestedById, 'u1');
    assert.equal(credited?.url, find.url);
    assert.equal(credited?.title, find.title);
    assert.equal(credited?.uploader, find.uploader);
    assert.equal(credited?.thumbnail, find.thumbnail);
    assert.equal(credited?.durationSec, find.durationSec);
    assert.equal(playFromFire(find, 'u2', true, true), null);
    assert.equal(playFromFire(find, 'u2', false, false), null);
  });

  it('blocks a 👎 find the way discover blocks a known song', () => {
    const tally = tallyReactions([row('u1', 'nope'), row('u2', 'fire', 'other|song')]);
    assert.deepEqual(tally.blocked, [{ artist: 'Viktor Sheen', title: 'Lavazza' }]);
    assert.equal(tally.fires.get('other|song'), 1);
    assert.equal(tally.nopes.get('sheen|lavazza'), 1);
  });
});

describe('reaction weights', () => {
  it('leaves a song out of sets while 👎 outnumber 🔥', () => {
    const pool = [kitchen('a'), kitchen('buried', 1, 3), kitchen('c')];
    for (let i = 0; i < 20; i += 1) {
      assert.notEqual(pickSong(pool, [])?.key, 'buried');
    }
    assert.equal(pickSong([kitchen('buried', 1, 3)], []), null);
    const genre = [kitchen('a'), kitchen('buried', 0, 2), kitchen('c'), kitchen('d')];
    const picked = genreSongs(
      genre,
      [],
      'rock',
      () => 'rock',
      () => 0,
    );
    assert.ok(picked.every((song) => song.key !== 'buried'));
  });

  it('picks a 🔥 song more often and still keeps the repeat gap', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'hot'];
    const pool = keys.map((key) => kitchen(key, key === 'hot' ? 30 : 0));
    const recent = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'hot'];
    for (let i = 0; i < 30; i += 1) {
      const pick = pickSong(pool, recent, () => i / 30);
      assert.notEqual(pick?.key, 'hot');
      assert.ok(pick?.key === 'j' || pick?.key === 'k');
    }

    const rng = mulberry32(3);
    let hits = 0;
    for (let i = 0; i < 200; i += 1) {
      if (pickSong(pool, [], rng)?.key === 'hot') hits += 1;
    }
    assert.ok(hits > 100, `hot song came up ${hits} times`);

    const genre = ['a', 'b', 'c', 'd', 'e', 'hot'].map((key) =>
      kitchen(key, key === 'hot' ? 40 : 0),
    );
    let hotIn = 0;
    let coldIn = 0;
    for (let seed = 1; seed <= 80; seed += 1) {
      const draw = mulberry32(seed);
      const set = genreSongs(genre, [], 'rock', () => 'rock', draw);
      if (set.some((song) => song.key === 'hot')) hotIn += 1;
      if (set.some((song) => song.key === 'a')) coldIn += 1;
    }
    assert.ok(hotIn > coldIn, `hot ${hotIn}, cold ${coldIn}`);
  });
});
