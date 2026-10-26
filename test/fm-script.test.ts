import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_SONG_SEC,
  SET_MAX,
  cleanLine,
  isSameSong,
  parsePlan,
  pickSong,
  relativeDay,
  sampleCrate,
  setRequest,
  templateOpener,
  themedSet,
  type FmSong,
  type OpenerFacts,
  type SetFacts,
} from '../src/fm/script';

const NOW = new Date('2026-10-26T18:00:00Z');
const DAY = 86_400_000;

function songs(...keys: string[]) {
  return keys.map((key) => ({ key, durationSec: 200 }));
}

function song(key: string, overrides: Partial<FmSong> = {}): FmSong {
  return {
    key,
    artist: 'Artist',
    title: key,
    label: `Artist — ${key}`,
    query: `Artist - ${key}`,
    durationSec: 200,
    from: { kind: 'play', userId: 'u2' },
    at: new Date(NOW.getTime() - 10 * DAY),
    ...overrides,
  };
}

function opener(overrides: Partial<OpenerFacts> = {}): OpenerFacts {
  return {
    language: 'en',
    server: 'The Kitchen',
    hour: 18,
    minute: 0,
    set: 1,
    newcomers: [],
    vibe: { kind: 'picks', name: 'Vojta' },
    first: { artist: 'Linkin Park', title: 'Numb', by: 'Vojta', how: 'play' },
    ...overrides,
  };
}

function setFacts(overrides: Partial<SetFacts> = {}): SetFacts {
  return {
    language: 'en',
    server: 'The Kitchen',
    time: 'Sun 18:04',
    hour: 18,
    minute: 4,
    set: 2,
    earlierVibes: ['sunday slow start'],
    playedThisShow: ['Kabát – Pohoda'],
    listeners: ['Vojta', 'Matěj'],
    newcomers: [],
    discover: 2,
    crate: [
      {
        n: 1,
        artist: 'Linkin Park',
        title: 'Numb',
        by: 'Vojta',
        how: 'play',
        when: '3 days ago',
        station: null,
      },
      {
        n: 2,
        artist: 'Kabát',
        title: 'Pohoda',
        by: 'Matěj',
        how: 'catch',
        when: 'yesterday',
        station: 'Radio Beat',
      },
    ],
    ...overrides,
  };
}

describe('pickSong', () => {
  it('skips songs that played recently', () => {
    const pool = songs('a', 'b', 'c');
    for (let i = 0; i < 20; i += 1) {
      assert.equal(pickSong(pool, ['a', 'b'])?.key, 'c');
    }
  });

  it('still rotates a tiny pool, but never repeats the last song', () => {
    const pool = songs('a', 'b');
    for (let i = 0; i < 20; i += 1) {
      assert.equal(pickSong(pool, ['a', 'b'])?.key, 'a');
    }
  });

  it('leaves out mixes and podcasts', () => {
    const pool = [
      { key: 'mix', durationSec: MAX_SONG_SEC + 1 },
      { key: 'song', durationSec: 180 },
    ];
    assert.equal(pickSong(pool, [])?.key, 'song');
  });

  it('plays a catch whose length is not known yet', () => {
    assert.equal(pickSong([{ key: 'caught', durationSec: 0 }], [])?.key, 'caught');
  });

  it('answers null for an empty pool', () => {
    assert.equal(pickSong([], []), null);
  });
});

describe('sampleCrate', () => {
  it('puts unplayed songs first and recent ones last, least recent first', () => {
    const pool = songs('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
    const crate = sampleCrate(pool, ['c', 'a', 'b']).map((entry) => entry.key);
    assert.equal(crate.length, 10);
    assert.deepEqual(crate.slice(-3), ['c', 'a', 'b']);
  });

  it('stops at the crate size and leaves out mixes', () => {
    const pool = [...songs('a', 'b', 'c', 'd'), { key: 'mix', durationSec: MAX_SONG_SEC + 1 }];
    const crate = sampleCrate(pool, [], 3);
    assert.equal(crate.length, 3);
    assert.ok(crate.every((entry) => entry.key !== 'mix'));
  });
});

describe('themedSet', () => {
  const pool = [
    song('a', { from: { kind: 'play', userId: 'u1' } }),
    song('b', { from: { kind: 'play', userId: 'u1' } }),
    song('c', { from: { kind: 'play', userId: 'u1' } }),
    song('d'),
  ];
  const listeners = new Map([['u1', 'Vojta']]);

  it("plays a listener's picks", () => {
    const set = themedSet(pool, [], { listeners, now: NOW, rng: () => 0 });
    assert.deepEqual(set?.theme, { kind: 'picks', name: 'Vojta' });
    assert.deepEqual(set?.songs.map((entry) => entry.key).sort(), ['a', 'b', 'c']);
  });

  it('never runs the same kind of set twice in a row', () => {
    const set = themedSet(pool, [], { listeners, last: 'picks', now: NOW, rng: () => 0 });
    assert.notEqual(set?.theme.kind, 'picks');
  });

  it('mixes everything now and then', () => {
    const set = themedSet(pool, [], { listeners, now: NOW, rng: () => 0.9 });
    assert.equal(set?.theme.kind, 'mix');
    assert.equal(set?.songs.length, 4);
  });

  it('answers null for an empty pool', () => {
    assert.equal(themedSet([], [], { listeners, now: NOW }), null);
  });
});

describe('relativeDay', () => {
  const now = new Date('2026-10-26T20:00:00Z');
  it('says today, yesterday, days, weeks, and months', () => {
    assert.equal(relativeDay(new Date('2026-10-26T08:00:00Z'), now), 'today');
    assert.equal(relativeDay(new Date('2026-10-25T08:00:00Z'), now), 'yesterday');
    assert.equal(relativeDay(new Date('2026-10-21T20:00:00Z'), now), '5 days ago');
    assert.equal(relativeDay(new Date('2026-10-05T20:00:00Z'), now), '3 weeks ago');
    assert.equal(relativeDay(new Date('2026-06-26T20:00:00Z'), now), '4 months ago');
  });
});

describe('parsePlan', () => {
  const crate = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }, { n: 7 }];

  it('keeps crate songs that exist, new finds within the allowance, and nothing twice', () => {
    const plan = parsePlan(
      JSON.stringify({
        vibe: 'Friday warm-up.',
        line: "\"It's 6 PM and we're going for a Friday warm-up. Here's Numb.\"",
        songs: [
          { crate: 2, artist: 'Linkin Park', title: 'Numb' },
          { crate: 99, artist: 'Nobody', title: 'Nothing' },
          { crate: null, artist: 'Daft Punk', title: 'Digital Love' },
          { crate: null, artist: 'Justice', title: 'D.A.N.C.E.' },
          { crate: 2, artist: 'Linkin Park', title: 'Numb' },
        ],
      }),
      crate,
      1,
    );
    assert.equal(plan?.vibe, 'Friday warm-up');
    assert.equal(plan?.line, "It's 6 PM and we're going for a Friday warm-up. Here's Numb.");
    assert.deepEqual(plan?.songs, [
      { crate: 2, artist: 'Linkin Park', title: 'Numb' },
      { crate: null, artist: 'Daft Punk', title: 'Digital Love' },
    ]);
  });

  it('drops the line when its first song is gone', () => {
    const plan = parsePlan(
      JSON.stringify({
        vibe: 'late night',
        line: 'Here is a song you will not hear.',
        songs: [
          { crate: 42, artist: 'A', title: 'B' },
          { crate: 1, artist: 'C', title: 'D' },
        ],
      }),
      crate,
      0,
    );
    assert.equal(plan?.line, '');
    assert.equal(plan?.songs.length, 1);
  });

  it(`stops at ${SET_MAX} songs`, () => {
    const plan = parsePlan(
      JSON.stringify({
        vibe: 'everything',
        line: 'All of it.',
        songs: crate.map((entry) => ({ crate: entry.n, artist: 'A', title: `S${entry.n}` })),
      }),
      crate,
      0,
    );
    assert.equal(plan?.songs.length, SET_MAX);
  });

  it('answers null for broken JSON or a set without songs', () => {
    assert.equal(parsePlan('not json', crate, 1), null);
    assert.equal(parsePlan('{"vibe":"x","line":"y","songs":[]}', crate, 1), null);
    assert.equal(parsePlan('{"vibe":"","line":"y","songs":[{"crate":1}]}', crate, 1), null);
  });
});

describe('isSameSong', () => {
  const want = { artist: 'Daft Punk', title: 'Digital Love' };

  it('finds the song on an official upload or a Topic channel', () => {
    assert.ok(isSameSong(want, { title: 'Daft Punk - Digital Love (Official Video)' }));
    assert.ok(isSameSong(want, { title: 'Digital Love', uploader: 'Daft Punk - Topic' }));
  });

  it('turns down another artist, a nightcore edit, or a different song', () => {
    assert.ok(!isSameSong(want, { title: 'Digital Love', uploader: 'Some Band' }));
    assert.ok(!isSameSong(want, { title: 'Nightcore - Digital Love (Daft Punk)' }));
    assert.ok(!isSameSong({ artist: 'Daft Punk', title: 'Love' }, { title: 'Daft Punk - Lovers' }));
  });

  it('looks past featured artists', () => {
    assert.ok(
      isSameSong(
        { artist: 'Daft Punk', title: 'Get Lucky (feat. Pharrell Williams)' },
        { title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers' },
      ),
    );
  });
});

describe('cleanLine', () => {
  it('drops emoji, markdown, and wrapping quotes', () => {
    assert.equal(
      cleanLine('"🎶 Next up: **Numb** by _Linkin Park_ 🍪"'),
      'Next up: Numb by Linkin Park',
    );
  });

  it('cuts a long answer at a sentence end', () => {
    const line = cleanLine(`${'This is a sentence that keeps going. '.repeat(14)}`);
    assert.ok(line.length <= 320);
    assert.ok(line.endsWith('.'));
  });

  it('leaves an empty answer empty, for the short line to take over', () => {
    assert.equal(cleanLine('  '), '');
  });
});

describe('templateOpener', () => {
  it('opens the show with the server, the time, and the vibe', () => {
    assert.equal(
      templateOpener(opener()),
      "Good evening, The Kitchen, this is Kitchen FM. It's 6 PM, and we're going for a few of Vojta's picks. First up, Numb by Linkin Park, brought in by Vojta.",
    );
  });

  it("welcomes newcomers and says who caught a song, with Claude's vibe", () => {
    const line = templateOpener(
      opener({
        set: 3,
        minute: 4,
        newcomers: ['Ana', 'Ben'],
        vibe: 'late night slow burners',
        first: { artist: 'Linkin Park', title: 'Numb', by: 'Matěj', how: 'catch' },
      }),
      () => 0.1,
    );
    assert.equal(
      line,
      "Hey Ana and Ben, welcome in. It's 6:04 PM on Kitchen FM, and we're going for late night slow burners. Here's Numb by Linkin Park, caught by Matěj.",
    );
  });

  it('calls a new find new, and reads the small hours', () => {
    const line = templateOpener(
      opener({
        set: 2,
        hour: 0,
        minute: 30,
        vibe: { kind: 'throwbacks' },
        first: { artist: 'Daft Punk', title: 'Digital Love', by: null, how: 'new' },
      }),
      () => 0.9,
    );
    assert.equal(
      line,
      'Kitchen FM, 12:30 AM. Time for some kitchen throwbacks, starting with Digital Love by Daft Punk, a new one for the kitchen.',
    );
  });

  it('speaks Czech without declining names', () => {
    const line = templateOpener(
      opener({
        language: 'cs',
        minute: 4,
        vibe: { kind: 'catches' },
        first: { artist: 'Linkin Park', title: 'Numb', by: 'Vojta', how: 'catch' },
      }),
    );
    assert.equal(
      line,
      'Dobrý večer, The Kitchen, tady Kitchen FM. Je 18:04 a teď hrají úlovky z rádia. Začínáme: Numb – Linkin Park. Úlovek: Vojta.',
    );
  });
});

describe('setRequest', () => {
  it('names the language and the new finds, and sends the facts and crate as JSON', () => {
    const text = setRequest(setFacts({ language: 'cs' }));
    assert.match(text, /^Speak Czech/);
    assert.match(text, /up to 2 new finds/);
    const facts = JSON.parse(
      text.slice(text.indexOf('Facts:\n') + 7, text.indexOf('\n\nCrate:')),
    ) as Record<string, unknown>;
    assert.equal(facts.time, 'Sun 18:04');
    for (const hidden of ['language', 'hour', 'minute', 'discover', 'crate']) {
      assert.equal(facts[hidden], undefined, hidden);
    }
    const crate = text
      .slice(text.indexOf('Crate:\n') + 7, text.indexOf('\n\nPlan the set now.'))
      .split('\n')
      .map((line) => JSON.parse(line) as { n: number; station: string | null });
    assert.deepEqual(
      crate.map((entry) => entry.n),
      [1, 2],
    );
    assert.equal(crate[1]?.station, 'Radio Beat');
  });

  it('keeps to the crate when new finds are off', () => {
    assert.match(setRequest(setFacts({ discover: 0 })), /no new finds/);
  });
});
