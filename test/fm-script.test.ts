import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_SONG_SEC,
  cleanLine,
  djRequest,
  pickSong,
  relativeDay,
  templateLine,
  type DjFacts,
} from '../src/fm/script';

function songs(...keys: string[]) {
  return keys.map((key) => ({ key, durationSec: 200 }));
}

function facts(overrides: Partial<DjFacts> = {}): DjFacts {
  return {
    language: 'en',
    server: 'The Kitchen',
    time: 'Sun 23:40',
    hour: 23,
    songNumber: 4,
    previous: { artist: 'Kabát', title: 'Pohoda' },
    next: {
      artist: 'Linkin Park',
      title: 'Numb',
      by: 'Vojta',
      how: 'play',
      when: '3 days ago',
      station: null,
    },
    listeners: ['Vojta', 'Matěj'],
    newcomers: [],
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

describe('cleanLine', () => {
  it('drops emoji, markdown, and wrapping quotes', () => {
    assert.equal(
      cleanLine('"🎶 Next up: **Numb** by _Linkin Park_ 🍪"'),
      'Next up: Numb by Linkin Park',
    );
  });

  it('cuts a long answer at a sentence end', () => {
    const line = cleanLine(`${'This is a sentence that keeps going. '.repeat(12)}`);
    assert.ok(line.length <= 280);
    assert.ok(line.endsWith('.'));
  });

  it('leaves an empty answer empty, for the short line to take over', () => {
    assert.equal(cleanLine('  '), '');
  });
});

describe('templateLine', () => {
  it('opens the show with the server and the time of day', () => {
    const line = templateLine(facts({ songNumber: 1, previous: null }));
    assert.equal(
      line,
      'Good evening, The Kitchen, this is Kitchen FM. First up, Numb by Linkin Park, brought in by Vojta.',
    );
  });

  it('says who caught a radio catch', () => {
    const line = templateLine(
      facts({ next: { ...facts().next, how: 'catch', by: 'Matěj' } }),
      () => 0.9,
    );
    assert.equal(line, 'Up next on Kitchen FM: Numb by Linkin Park, caught by Matěj.');
  });

  it('looks back at the song that just played', () => {
    assert.equal(
      templateLine(facts(), () => 0.1),
      "That was Pohoda. Here's Numb by Linkin Park, brought in by Vojta.",
    );
  });

  it('speaks Czech without declining names', () => {
    const line = templateLine(facts({ language: 'cs' }), () => 0.9);
    assert.equal(line, 'Na Kitchen FM teď hraje Numb – Linkin Park. Vybírá Vojta.');
  });
});

describe('djRequest', () => {
  it('sends the facts as JSON and names the language', () => {
    const text = djRequest(facts({ language: 'cs' }));
    assert.match(text, /^Speak Czech\./);
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<
      string,
      unknown
    >;
    assert.equal((json.next as { title: string }).title, 'Numb');
    assert.equal(json.language, undefined);
    assert.equal(json.hour, undefined);
  });
});
