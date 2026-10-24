import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  QUIZ_ANSWER_MS,
  QUIZ_CHOICES,
  QUIZ_CLIP_SEC,
  buildChoices,
  cleanTitle,
  clipStart,
  dedupeSongs,
  roundPoints,
  songFromCatch,
  songFromTrack,
  type QuizSong,
} from '../src/quiz/songs';

/** Deterministic rng (mulberry32), so a failing shuffle can be replayed. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function song(artist: string, title: string): QuizSong {
  return songFromCatch({ artist, title, userId: 'u' });
}

describe('roundPoints', () => {
  it('gives 150 for an instant answer', () => {
    assert.equal(roundPoints(0, 1), 150);
  });

  it('falls to 100 at the end of the window', () => {
    assert.equal(roundPoints(QUIZ_ANSWER_MS, 1), 100);
    assert.equal(roundPoints(QUIZ_ANSWER_MS * 2, 1), 100);
  });

  it('gives half the speed bonus halfway through', () => {
    assert.equal(roundPoints(QUIZ_ANSWER_MS / 2, 1), 125);
  });

  it('adds 25 on every third right answer in a row', () => {
    assert.equal(roundPoints(QUIZ_ANSWER_MS, 2), 100);
    assert.equal(roundPoints(QUIZ_ANSWER_MS, 3), 125);
    assert.equal(roundPoints(QUIZ_ANSWER_MS, 6), 125);
    assert.equal(roundPoints(QUIZ_ANSWER_MS, 0), 100);
  });
});

describe('buildChoices', () => {
  const pool = [
    song('Queen', 'Bohemian Rhapsody'),
    song('Queen', 'Under Pressure'),
    song('ABBA', 'Dancing Queen'),
    song('Toto', 'Africa'),
    song('a-ha', 'Take On Me'),
    song('Europe', 'The Final Countdown'),
  ];

  it('offers four distinct labels including the answer', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const answer = pool[seed % pool.length]!;
      const { labels, correct } = buildChoices(pool, answer, seeded(seed));
      assert.equal(labels.length, QUIZ_CHOICES);
      assert.equal(new Set(labels).size, QUIZ_CHOICES);
      assert.equal(labels[correct], answer.label);
    }
  });

  it('prefers decoys by other artists', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { labels } = buildChoices(pool, pool[0]!, seeded(seed));
      assert.ok(!labels.includes(pool[1]!.label), 'the other Queen song should not be a decoy');
    }
  });

  it('works with a pool of exactly four', () => {
    const small = pool.slice(2);
    const { labels, correct } = buildChoices(small, small[0]!, seeded(7));
    assert.equal(labels.length, 4);
    assert.equal(labels[correct], small[0]!.label);
  });
});

describe('clipStart', () => {
  it('starts 35 % in, between 20 s and 90 s', () => {
    assert.equal(clipStart(200), 70);
    assert.equal(clipStart(40), 20);
    assert.equal(clipStart(600), 90);
  });

  it('never runs the clip past the end', () => {
    const start = clipStart(30);
    assert.ok(start + QUIZ_CLIP_SEC < 30);
  });

  it('guesses 45 s for an unknown length', () => {
    assert.equal(clipStart(0), 45);
  });
});

describe('cleanTitle', () => {
  it('drops video noise and label suffixes', () => {
    assert.equal(cleanTitle('Toto - Africa (Official Video) [4K] | Columbia'), 'Toto - Africa');
    assert.equal(cleanTitle('Song (Remastered 2011)'), 'Song');
  });

  it('keeps meaningful brackets', () => {
    assert.equal(cleanTitle('Song (feat. Someone)'), 'Song (feat. Someone)');
  });
});

describe('songFromTrack', () => {
  it('splits "Artist - Title"', () => {
    const s = songFromTrack(
      { title: 'Toto - Africa (Official Video)', url: 'u', durationSec: 295 },
      { kind: 'play' },
    );
    assert.equal(s.artist, 'Toto');
    assert.equal(s.title, 'Africa');
  });

  it('uses the channel as the artist otherwise', () => {
    const s = songFromTrack(
      { title: 'Africa', url: 'u', durationSec: 295, uploader: 'Toto - Topic' },
      { kind: 'play' },
    );
    assert.equal(s.artist, 'Toto');
  });
});

describe('dedupeSongs', () => {
  it('keeps the first of each song', () => {
    const songs = [song('Toto', 'Africa'), song('TOTO', 'africa'), song('Toto', 'Rosanna')];
    assert.deepEqual(
      dedupeSongs(songs).map((s) => s.title),
      ['Africa', 'Rosanna'],
    );
  });

  it('drops songs without a title', () => {
    assert.equal(dedupeSongs([song('Toto', '')]).length, 0);
  });
});
