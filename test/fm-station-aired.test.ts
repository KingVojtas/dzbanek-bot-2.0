import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '../src/core/logger';
import type { AiredSong } from '../src/quiz/stores';
import { splitPlayed, StationAired } from '../src/fm/station-aired';
import type { FmSong } from '../src/fm/script';

const logger = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

function song(key: string, url?: string): FmSong {
  return {
    key,
    label: key,
    artist: 'Artist',
    title: key,
    query: key,
    url,
    durationSec: 180,
    at: new Date(0),
    from: { kind: 'play' },
  } as FmSong;
}

function row(partial: Partial<AiredSong> & Pick<AiredSong, 'songKey' | 'title'>): AiredSong {
  return {
    url: '',
    artist: 'Artist',
    playedAt: new Date(0),
    ...partial,
  };
}

function memory(played: string[] = [], dead?: { artist: string; title: string }[]) {
  return new StationAired({ logger, played: () => played, deadFinds: dead });
}

describe('splitPlayed', () => {
  it('splits the dash the played list stores, and keeps a bare title', () => {
    assert.deepEqual(splitPlayed('Nova – Lavazza'), { artist: 'Nova', title: 'Lavazza' });
    assert.deepEqual(splitPlayed('Nova — Lavazza'), { artist: 'Nova', title: 'Lavazza' });
    assert.deepEqual(splitPlayed('Nova - Lavazza - Live'), {
      artist: 'Nova',
      title: 'Lavazza - Live',
    });
    assert.deepEqual(splitPlayed('Lavazza'), { artist: '', title: 'Lavazza' });
  });
});

describe('StationAired', () => {
  it('keeps the latest play when the same song aired twice', async () => {
    const aired = new StationAired({
      logger,
      played: () => [],
      aired: async () => [
        row({ songKey: 'a', title: 'Aye', url: 'https://youtu.be/a', playedAt: new Date(1_000) }),
        row({ songKey: 'a', title: 'Aye', url: 'https://youtu.be/a', playedAt: new Date(5_000) }),
        row({ songKey: '', url: 'https://youtu.be/b', title: 'Bee', playedAt: new Date(2_000) }),
      ],
    });
    await aired.readAired();
    assert.equal(aired.airedNow.keys.size, 1);
    assert.equal(aired.lastAiredAt(song('a', 'https://youtu.be/a')), 5_000);
    assert.equal(aired.taken(song('a')), true);
    assert.equal(aired.taken(song('missing', 'https://youtu.be/b')), true);
    assert.equal(aired.lastAiredAt(song('never')), 0);
  });

  it('treats a failed read as nothing aired', async () => {
    const warnings: unknown[][] = [];
    const aired = new StationAired({
      logger: { ...logger, warn: (...args: unknown[]) => warnings.push(args) } as unknown as Logger,
      played: () => [],
      aired: async () => {
        throw new Error('down');
      },
    });
    await aired.readAired();
    assert.equal(aired.airedNow.rows.length, 0);
    assert.equal(aired.taken(song('a')), false);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /could not read what it already aired/);
  });

  it('plans by key or link, and ignores an empty key', () => {
    const aired = memory();
    aired.markPlanned('|', undefined);
    aired.markPlanned(undefined, 'https://youtu.be/a');
    assert.equal(aired.plannedKeys.size, 0);
    assert.equal(aired.plannedThisShow(song('a')), false);
    assert.equal(aired.plannedThisShow(song('other', 'https://youtu.be/a')), true);
    aired.markPlanned('a', 'https://youtu.be/a');
    assert.equal(aired.taken(song('a')), true);
  });

  it('appends a missed find to the shared list and drops the oldest past 500', () => {
    const shared: { artist: string; title: string }[] = [];
    const aired = memory([], shared);
    aired.noteDead('Nova', 'Lavazza');
    aired.noteDead('Nova', 'Lavazza');
    assert.deepEqual(shared, [{ artist: 'Nova', title: 'Lavazza' }]);
    for (let i = 0; i < 500; i += 1) aired.noteDead('A', String(i));
    assert.equal(shared.length, 500);
    assert.deepEqual(shared[0], { artist: 'A', title: '0' });
    assert.equal(aired.airedNames().matches({ artist: 'Nova', title: 'Lavazza' }), false);
  });

  it('tells Claude this show first, then the newest aired songs, up to 30', async () => {
    const played = ['Shown – One'];
    const aired = new StationAired({
      logger,
      played: () => played,
      aired: async () => [
        row({ songKey: 'old', title: 'Old', artist: 'A', playedAt: new Date(1) }),
        row({ songKey: 'new', title: 'New', artist: 'B', playedAt: new Date(9) }),
        row({ songKey: 'dup', title: 'One', artist: 'Shown', playedAt: new Date(8) }),
        row({ songKey: 'bare', title: 'Bare', artist: '', playedAt: new Date(7) }),
      ],
    });
    await aired.readAired();
    assert.deepEqual(aired.playedForClaude(), ['Shown – One', 'B – New', 'Bare', 'A – Old']);
    played.push(...Array.from({ length: 30 }, (_, i) => `Song ${i}`));
    assert.equal(aired.playedForClaude().length, 30);
    assert.equal(aired.playedForClaude()[0], 'Song 0');
  });
});
