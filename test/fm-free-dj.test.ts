import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/core/logger';
import {
  countryFromSearch,
  deezerHitFromSearch,
  genreNamesFromAlbum,
  musicBrainzQuery,
  relatedFromBody,
  topsFromBody,
  type FmCatalog,
} from '../src/fm/catalog';
import { GenreBook } from '../src/fm/GenreBook';
import {
  artistKey,
  classifyGenre,
  genresReady,
  readGenreCache,
  writeGenreCache,
  type GenreId,
} from '../src/fm/genres';
import {
  blanksIn,
  fillLine,
  lineTime,
  loadLineBook,
  momentsFor,
  readLineFile,
  songPhrase,
  takeLine,
  wordCount,
  LINE_BLANKS,
  LINE_MOMENTS,
  type LineSlots,
  type Moment,
} from '../src/fm/lines';
import type { FmSong } from '../src/fm/script';
import {
  blockOverruns,
  blockProfile,
  findAllowance,
  genreSongs,
  kitchenSlots,
  nextGenre,
  pickDiscoverTrack,
  seedArtistIds,
  tasteProfile,
  BLOCK_GRACE_MS,
} from '../src/fm/taste';

const NOW = Date.parse('2026-10-26T16:00:00Z');
const DAY = 86_400_000;

function song(key: string, overrides: Partial<FmSong> = {}): FmSong {
  return {
    key,
    artist: 'Artist',
    title: key,
    label: `Artist — ${key}`,
    query: `Artist - ${key}`,
    durationSec: 200,
    from: { kind: 'play', userId: 'fan' },
    at: new Date(NOW),
    ...overrides,
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

describe('classifyGenre', () => {
  it('puts Czech and Slovak rap on their own shelf, and Dance with EDM', () => {
    assert.equal(classifyGenre(['Rap/Hip Hop'], 'CZ'), 'cz-rap');
    assert.equal(classifyGenre(['Hip-Hop'], 'SK'), 'cz-rap');
    assert.equal(classifyGenre(['Rap/Hip Hop'], 'US'), 'rap');
    assert.equal(classifyGenre(['Dance'], null), 'edm');
    assert.equal(classifyGenre(['Electro'], 'FR'), 'edm');
    assert.equal(classifyGenre(['Drum and Bass'], 'UK'), 'edm');
    assert.equal(classifyGenre(['Pop'], 'CZ'), 'cz-pop');
    assert.equal(classifyGenre(['Pop'], 'US'), 'pop');
    assert.equal(classifyGenre(['Rock'], 'CZ'), 'rock');
    assert.equal(classifyGenre(['Metal', 'Rock'], 'US'), 'metal');
    assert.equal(classifyGenre(['R&B'], null), 'rnb');
    assert.equal(classifyGenre(['Alternative'], null), 'indie');
    assert.equal(classifyGenre(['Alternativní hudba'], null), 'indie');
    assert.equal(classifyGenre(['Elektronická hudba'], null), 'edm');
    assert.equal(classifyGenre(['Taneční hudba'], 'CZ'), 'edm');
    assert.equal(classifyGenre(['Latin Music'], 'CO'), 'latin');
    assert.equal(classifyGenre(['Jazz'], 'US'), 'other');
    assert.equal(classifyGenre([], null), 'other');
  });
});

describe('genresReady', () => {
  it('starts blocks at 30 songs, or at 60% of a smaller kitchen', () => {
    assert.equal(genresReady(30, 100), true);
    assert.equal(genresReady(29, 100), false);
    assert.equal(genresReady(6, 10), true);
    assert.equal(genresReady(0, 10), false);
  });
});

describe('genre cache file', () => {
  it('round-trips through a temp file and treats a missing file as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-genres-'));
    const path = join(dir, 'fm-genres.json');
    assert.deepEqual(readGenreCache(path).songs, {});
    writeGenreCache(path, {
      version: 1,
      songs: { 'a|b': { genre: 'rock', deezerArtistId: 4 } },
      artists: { a: { country: 'US' } },
    });
    assert.equal(readGenreCache(path).songs['a|b']?.genre, 'rock');
    assert.equal(artistKey('Linkin Park'), artistKey('linkin park'));
  });
});

describe('tasteProfile', () => {
  const genreOf = (item: FmSong): GenreId =>
    item.key.startsWith('rap') ? 'cz-rap' : item.key.startsWith('rock') ? 'rock' : 'other';

  it('halves a catch, boosts whoever is listening, and ignores other', () => {
    const weights = tasteProfile(
      [
        song('rap-now'),
        song('rap-old', { at: new Date(NOW - 30 * DAY) }),
        song('rap-catch', { from: { kind: 'catch', userId: 'fan' } }),
        song('rock-here', { from: { kind: 'play', userId: 'here' } }),
        song('jazz'),
      ],
      genreOf,
      { now: NOW, listenerIds: new Set(['here']) },
    );
    assert.ok(Math.abs((weights.get('cz-rap') ?? 0) - (1 + 0.5 + 0.5)) < 1e-9);
    assert.ok(Math.abs((weights.get('rock') ?? 0) - 1.5) < 1e-9);
    assert.equal(weights.has('other'), false);
  });
});

describe('nextGenre', () => {
  const profile = new Map<GenreId, number>([
    ['cz-rap', 10],
    ['rock', 2],
    ['edm', 2],
    ['pop', 1],
  ]);

  it('opens on the favourite and then leaves out the genre just played', () => {
    assert.equal(
      nextGenre(profile, [], () => 0.99),
      'cz-rap',
    );
    const again = nextGenre(profile, ['cz-rap'], () => 0);
    assert.notEqual(again, 'cz-rap');
    assert.equal(
      nextGenre(new Map([['rock', 3]]), ['rock'], () => 0.5),
      'rock',
    );
  });

  it('plays the favourite most often across a long show', () => {
    const rng = mulberry32(7);
    const history: GenreId[] = [];
    const counts = new Map<GenreId, number>();
    for (let i = 0; i < 80; i += 1) {
      const genre = nextGenre(profile, history, rng);
      assert.ok(genre);
      history.push(genre);
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    assert.equal(top, 'cz-rap');
    for (const [genre, count] of counts) {
      if (genre !== 'cz-rap') assert.ok(count < (counts.get('cz-rap') ?? 0));
    }
  });
});

describe('genre sets', () => {
  it('takes fresh songs of that genre and skips ones that just played', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => song(key));
    const picked = genreSongs(
      pool,
      ['a', 'b'],
      'rock',
      () => 'rock',
      () => 0,
    );
    assert.ok(picked.length >= 3 && picked.length <= 5);
    assert.ok(picked.every((item) => item.key !== 'a' && item.key !== 'b'));
  });

  it('gives nothing once every song of the genre played recently', () => {
    const pool = ['a', 'b', 'c'].map((key) => song(key));
    assert.deepEqual(
      genreSongs(pool, ['a', 'b', 'c'], 'rock', () => 'rock'),
      [],
    );
  });

  it('leaves genres without enough unplayed songs out of the block draw', () => {
    const pool = [
      ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map((key) => song(key)),
      song('m1'),
    ];
    const genreOf = (item: FmSong): GenreId => (item.key.startsWith('m') ? 'metal' : 'cz-rap');
    const profile = new Map<GenreId, number>([
      ['cz-rap', 7],
      ['metal', 1],
    ]);
    assert.deepEqual([...blockProfile(profile, pool, [], genreOf).keys()], ['cz-rap']);
    assert.deepEqual([...blockProfile(profile, pool, ['r1', 'r2'], genreOf).keys()], []);
  });

  it('allows more finds when the shelf has fewer than three fresh songs', () => {
    assert.equal(findAllowance(2, 5), 2);
    assert.equal(findAllowance(2, 1), 2);
    assert.equal(findAllowance(0, 0), 3);
    assert.equal(findAllowance(0, 4), 0);
    assert.equal(kitchenSlots(5, 2), 3);
    assert.equal(kitchenSlots(1, 2), 1);
  });

  it('starts the next block when a set would run more than about ten minutes past the hour', () => {
    const blockMs = 60 * 60_000;
    assert.equal(blockOverruns(50 * 60_000, 0, blockMs, 5 * 60), false);
    assert.equal(blockOverruns(66 * 60_000, 0, blockMs, 5 * 60), true);
    assert.equal(BLOCK_GRACE_MS, 10 * 60_000);
  });

  it('asks for listeners’ artists before the rest', () => {
    const ids = seedArtistIds(
      [
        { from: { userId: 'away' }, deezerArtistId: 1 },
        { from: { userId: 'here' }, deezerArtistId: 2 },
        { from: { userId: 'here' }, deezerArtistId: 2 },
        { from: { userId: 'away' }, deezerArtistId: 3 },
      ],
      new Set(['here']),
      () => 0,
    );
    assert.deepEqual(ids, [2, 3, 1]);
  });

  it('picks a top track the kitchen has not played', () => {
    const tops = [
      { artist: 'Daft Punk', title: 'Digital Love', durationSec: 300 },
      { artist: 'Justice', title: 'D.A.N.C.E.', durationSec: 200 },
      { artist: 'Mix', title: 'All Night Long', durationSec: 20 * 60 },
    ];
    const pick = pickDiscoverTrack(tops, [{ artist: 'Daft Punk', title: 'Digital Love' }], () => 0);
    assert.equal(pick?.title, 'D.A.N.C.E.');
  });
});

describe('line book', () => {
  const slots: LineSlots = {
    server: 'The Kitchen',
    time: '6 PM',
    daypart: 'evening',
    genre: 'Czech rap',
    song: 'Numb by Linkin Park',
    artist: 'Linkin Park',
    by: 'Vojta',
    names: 'Ana and Ben',
    station: 'Kitchen FM',
  };

  it('fills the blanks the way each language speaks', () => {
    assert.equal(songPhrase('Linkin Park', 'Numb', 'en'), 'Numb by Linkin Park');
    assert.equal(songPhrase('Linkin Park', 'Numb', 'cs'), 'Numb – Linkin Park');
    assert.equal(lineTime(18, 0, 'en'), '6 PM');
    assert.equal(lineTime(18, 4, 'en'), '6:04 PM');
    assert.equal(lineTime(18, 4, 'cs'), '18:04');
    assert.equal(
      fillLine('It is {time} on {server}, {song}.', slots),
      'It is 6 PM on The Kitchen, Numb by Linkin Park.',
    );
  });

  it('opens the show, welcomes, and credits the song in that order', () => {
    assert.deepEqual(
      momentsFor({
        set: 1,
        newBlock: true,
        hour: 18,
        newcomers: ['Ana'],
        how: 'play',
        by: 'Vojta',
      }),
      ['showOpen', 'byPlay'],
    );
    assert.deepEqual(
      momentsFor({ set: 3, newBlock: true, hour: 2, newcomers: ['Ana'], how: 'new', by: null }),
      ['welcome', 'lateNight', 'newFind'],
    );
    assert.deepEqual(
      momentsFor({ set: 2, newBlock: false, hour: 18, newcomers: [], how: 'catch', by: 'Matěj' }),
      ['setOpen', 'byCatch'],
    );
  });

  it('does not repeat a line while unused ones remain', () => {
    const used = new Set<number>();
    const seen = new Set<number>();
    for (let i = 0; i < 3; i += 1) seen.add(takeLine(['a', 'b', 'c'], used, () => 0));
    assert.equal(seen.size, 3);
  });

  for (const language of ['en', 'cs'] as const) {
    it(`keeps every ${language} line speakable`, () => {
      const file = readLineFile(language);
      assert.equal(file.version, 1);
      const known = new Set<string>(LINE_BLANKS);
      const seen = new Set<string>();
      for (const moment of Object.keys(LINE_MOMENTS) as Moment[]) {
        const rule = LINE_MOMENTS[moment];
        const lines = file.lines[moment];
        assert.ok(lines.length >= rule.min, `${moment} has ${lines.length}`);
        for (const line of lines) {
          assert.ok(wordCount(line) <= rule.words, line);
          assert.equal(line, line.normalize('NFKC'));
          assert.equal(/\p{Extended_Pictographic}/u.test(line), false, line);
          assert.equal(/[*_`#~<>[\]|]/.test(line), false, line);
          const blanks = blanksIn(line);
          for (const blank of blanks) assert.ok(known.has(blank), blank);
          for (const need of rule.needs) assert.ok(blanks.includes(need), `${moment}: ${line}`);
          assert.equal(seen.has(line), false, line);
          seen.add(line);
        }
      }
      const book = loadLineBook(language);
      const said = book?.speak(['showOpen', 'byPlay'], slots, new Map(), () => 0);
      assert.ok(said?.includes('The Kitchen') || said?.includes('{server}') === false);
      assert.match(said ?? '', /Numb/);
    });
  }
});

describe('catalog parsers', () => {
  it('reads a Deezer search hit, album genres, related artists, and top tracks', () => {
    const hit = deezerHitFromSearch(
      {
        data: [
          {
            id: 1,
            title: 'One More Time',
            artist: { id: 27, name: 'Daft Punk' },
            album: { id: 90, title: 'Discovery' },
          },
        ],
      },
      { artist: 'Daft Punk', title: 'One More Time' },
    );
    assert.equal(hit?.artistId, 27);
    assert.deepEqual(genreNamesFromAlbum({ genres: { data: [{ id: 113, name: 'Dance' }] } }), [
      'Dance',
    ]);
    assert.deepEqual(relatedFromBody({ data: [{ id: 5, name: 'Justice' }] }), [
      { id: 5, name: 'Justice' },
    ]);
    assert.deepEqual(
      topsFromBody({ data: [{ title: 'D.A.N.C.E.', duration: 241, artist: { name: 'Justice' } }] }),
      [{ title: 'D.A.N.C.E.', artist: 'Justice', durationSec: 241 }],
    );
    assert.equal(deezerHitFromSearch({ error: { code: 4 } }, { artist: 'A', title: 'B' }), null);
  });

  it('reads a MusicBrainz country only when the artist name matches', () => {
    const body = {
      artists: [
        { name: 'Somebody Else', score: 80, country: 'US' },
        { name: 'Viktor Sheen', score: '100', country: 'CZ' },
      ],
    };
    assert.equal(countryFromSearch(body, 'Viktor Sheen'), 'CZ');
    assert.equal(countryFromSearch({ artists: [] }, 'Viktor Sheen'), null);
    assert.equal(musicBrainzQuery('AC/DC'), 'artist:"AC/DC"');
  });
});

describe('GenreBook', () => {
  it('classifies a song in the background and remembers a miss without a genre lookup storm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-book-'));
    const path = join(dir, 'fm-genres.json');
    let searches = 0;
    const catalog: FmCatalog = {
      async searchTrack(artist) {
        searches += 1;
        if (artist === 'Missing') return { ok: true, value: null };
        if (artist === 'Offline') return { ok: false };
        return {
          ok: true,
          value: { title: 'Numb', artist: 'Linkin Park', albumId: 1, artistId: 9 },
        };
      },
      async albumGenres() {
        return { ok: true, value: ['Rock'] };
      },
      async relatedArtists() {
        return [];
      },
      async topTracks() {
        return [];
      },
      async artistCountry() {
        return { ok: true, value: 'US' };
      },
    };
    const book = new GenreBook(path, catalog, new Logger('error'));
    const songs = [
      { key: 'linkin park|numb', artist: 'Linkin Park', title: 'Numb' },
      { key: 'missing|song', artist: 'Missing', title: 'Song' },
      { key: 'offline|song', artist: 'Offline', title: 'Song' },
    ];
    book.enqueue(songs);
    for (let i = 0; i < 40 && book.genreOf('missing|song') !== 'other'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(book.genreOf('linkin park|numb'), 'rock');
    assert.equal(book.artistId('linkin park|numb'), 9);
    assert.equal(book.genreOf('missing|song'), 'other');
    assert.equal(book.genreOf('offline|song'), undefined);
    assert.equal(book.ready(songs), true);
    const before = searches;
    book.enqueue(songs);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(searches <= before + 1);
    assert.equal(readGenreCache(path).songs['linkin park|numb']?.genre, 'rock');
  });
});
