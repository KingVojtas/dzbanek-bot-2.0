import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chefOfTheWeek,
  songOfTheWeek,
  type ChefBringer,
  type ChefFire,
  type ChefPlay,
} from '../src/kitchen/chef';

const names: Record<string, string> = {
  vojta: 'Vojta',
  anna: 'Anna',
  petr: 'Petr',
  eva: 'Eva',
};

function fire(partial: Partial<ChefFire> & Pick<ChefFire, 'userId' | 'songKey'>): ChefFire {
  return {
    userId: partial.userId,
    songKey: partial.songKey,
    url: partial.url ?? `https://example/${partial.songKey}`,
    title: partial.title ?? partial.songKey,
    artist: partial.artist ?? 'Artist',
  };
}

function score(input: {
  fires?: ChefFire[];
  bringers?: ChefBringer[];
  plays?: ChefPlay[];
  catches?: { userId: string }[];
  championUserId?: string | null;
}) {
  return chefOfTheWeek({
    fires: input.fires ?? [],
    bringers: input.bringers ?? [],
    plays: input.plays ?? [],
    catches: input.catches ?? [],
    championUserId: input.championUserId ?? null,
    nameOf: (id) => names[id] ?? id,
  });
}

describe('chefOfTheWeek', () => {
  it('gives +3 per someone else’s fire, nothing for your own, and matches url or key', () => {
    const rows = score({
      bringers: [
        { userId: 'vojta', songKey: 'numb', url: 'https://example/numb' },
        { userId: 'anna', songKey: 'shared', url: 'https://example/shared' },
        { userId: 'eva', songKey: 'by-url', url: 'https://example/by-url' },
      ],
      fires: [
        fire({ userId: 'anna', songKey: 'numb' }),
        fire({ userId: 'petr', songKey: 'numb' }),
        fire({ userId: 'vojta', songKey: 'numb' }),
        fire({ userId: 'petr', songKey: 'shared' }),
        fire({ userId: 'anna', songKey: 'different', url: 'https://example/by-url' }),
      ],
      plays: [
        { userId: 'vojta', songKey: 'numb', kind: 'play' },
        { userId: 'vojta', songKey: 'numb', kind: 'dedication' },
        { userId: 'vojta', songKey: 'second', kind: 'play' },
        { userId: 'vojta', songKey: 'station', kind: 'fm' },
        { userId: 'vojta', songKey: 'find', kind: 'find' },
      ],
      catches: [{ userId: 'anna' }, { userId: 'anna' }],
    });
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    // Two fires from other people, and two distinct songs. The self-fire adds nothing.
    assert.equal(byName.Vojta?.fires, 2);
    assert.equal(byName.Vojta?.songs, 2);
    assert.equal(byName.Vojta?.points, 2 * 3 + 2);
    assert.equal(byName.Anna?.fires, 1);
    assert.equal(byName.Anna?.points, 3 + 2 * 2);
    assert.equal(byName.Eva?.fires, 1);
    assert.equal(byName.Eva?.points, 3);
    assert.deepEqual(
      rows.map((row) => row.name),
      ['Vojta', 'Anna', 'Eva'],
    );
  });

  it('adds 5 for the quiz champion', () => {
    const rows = score({ championUserId: 'petr' });
    assert.deepEqual(rows, [{ userId: 'petr', name: 'Petr', points: 5, fires: 0, songs: 0 }]);
  });

  it('breaks ties by fires, then songs, then name, and keeps three', () => {
    const rows = score({
      plays: [
        { userId: 'eva', songKey: 'a', kind: 'play' },
        { userId: 'anna', songKey: 'a', kind: 'play' },
        { userId: 'petr', songKey: 'a', kind: 'play' },
        { userId: 'petr', songKey: 'b', kind: 'play' },
        { userId: 'vojta', songKey: 'a', kind: 'play' },
      ],
      bringers: [{ userId: 'vojta', songKey: 'hot' }],
      fires: [fire({ userId: 'anna', songKey: 'hot' }), fire({ userId: 'petr', songKey: 'hot' })],
    });
    // Vojta: 6 + 1 = 7. Others: 1, except Petr has 2 songs so 2 points.
    assert.equal(rows[0]?.name, 'Vojta');
    assert.equal(rows[0]?.points, 7);
    assert.deepEqual(
      rows.slice(1).map((row) => row.name),
      ['Petr', 'Anna'],
    );

    const tied = score({
      plays: [
        { userId: 'eva', songKey: 'a', kind: 'play' },
        { userId: 'anna', songKey: 'a', kind: 'play' },
      ],
    });
    assert.deepEqual(
      tied.map((row) => row.name),
      ['Anna', 'Eva'],
    );
  });

  it('leaves out anyone with no points', () => {
    assert.deepEqual(score({ plays: [{ userId: 'vojta', songKey: 'a', kind: 'fm' }] }), []);
  });
});

describe('songOfTheWeek', () => {
  it('is the most fired song, with who brought it', () => {
    const song = songOfTheWeek({
      fires: [
        fire({ userId: 'vojta', songKey: 'numb', title: 'Numb', artist: 'Linkin Park' }),
        fire({ userId: 'anna', songKey: 'numb', title: 'Numb', artist: 'Linkin Park' }),
        fire({ userId: 'petr', songKey: 'other', title: 'Other', artist: 'Band' }),
      ],
      bringers: [{ userId: 'anna', songKey: 'numb', url: 'https://example/numb' }],
      nameOf: (id) => names[id] ?? id,
    });
    assert.equal(song?.title, 'Numb');
    assert.equal(song?.fires, 2);
    assert.deepEqual(song?.broughtBy, ['Anna']);
  });

  it('is null when nothing was fired', () => {
    assert.equal(songOfTheWeek({ fires: [], bringers: [], nameOf: () => '' }), null);
  });
});
