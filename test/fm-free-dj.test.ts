import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/core/logger';
import {
  areaStepFromLookup,
  artistFromSearch,
  countryFromSearch,
  deezerHitFromSearch,
  fetchMusicBrainz,
  genreNamesFromAlbum,
  MB_RETRY_MS,
  musicBrainzQuery,
  relatedFromBody,
  topsFromBody,
  type FmCatalog,
} from '../src/fm/catalog';
import { GenreBook } from '../src/fm/GenreBook';
import {
  artistKey,
  classifyGenre,
  GENRE_MISS_MS,
  genresReady,
  knownSongs,
  readGenreCache,
  songNeedsLookup,
  writeGenreCache,
  type GenreCacheFile,
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
  blockProfile,
  findAllowance,
  genreSongs,
  kitchenSlots,
  nextGenre,
  pickDiscoverTrack,
  seedArtistIds,
  tasteProfile,
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
    assert.equal(classifyGenre(['Alternative'], null), 'rock');
    assert.equal(classifyGenre(['Alternativní hudba'], null), 'rock');
    assert.equal(classifyGenre(['Indie Rock'], null), 'indie');
    assert.equal(classifyGenre(['Alternative Rock'], null), 'rock');
    assert.equal(classifyGenre(['Elektronická hudba'], null), 'edm');
    assert.equal(classifyGenre(['Taneční hudba'], 'CZ'), 'edm');
    assert.equal(classifyGenre(['Latin Music'], 'CO'), 'latin');
    assert.equal(classifyGenre(['Jazz'], 'US'), 'other');
    assert.equal(classifyGenre([], null), 'other');
  });

  it('lets a tag family beat Deezer only when its votes lead', () => {
    const dragons = [
      { name: 'alternative rock', count: 15 },
      { name: 'pop rock', count: 11 },
      { name: 'indie pop', count: 9 },
      { name: 'electropop', count: 2 },
    ];
    assert.equal(classifyGenre(['Dance'], null, dragons), 'rock');
    assert.equal(
      classifyGenre(['Pop'], 'CZ', [
        { name: 'czech', count: 3 },
        { name: 'rock', count: 5 },
      ]),
      'rock',
    );
    assert.equal(classifyGenre(['Pop'], 'CZ', [{ name: 'hip hop', count: 4 }]), 'cz-rap');
    assert.equal(classifyGenre(['Jazz'], 'FR', [{ name: 'electronic', count: 2 }]), 'edm');
    assert.equal(classifyGenre(['Pop'], 'US', [{ name: 'metal', count: 2 }]), 'metal');
    assert.equal(classifyGenre(['Pop'], 'CZ', [{ name: 'rock', count: 1 }]), 'cz-pop');
    assert.equal(
      classifyGenre(['Dance'], null, [
        { name: 'rock', count: 3 },
        { name: 'electropop', count: 3 },
      ]),
      'edm',
    );
    assert.equal(classifyGenre(['Rock'], 'CZ', [{ name: 'czech', count: 9 }]), 'rock');
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
    assert.equal(readGenreCache(path).artists.a?.tags, undefined);
    assert.deepEqual(readGenreCache(path).areas, {});
    writeGenreCache(path, {
      version: 1,
      songs: {},
      artists: { kabat: { country: 'CZ', tags: ['rock'] } },
    });
    assert.deepEqual(readGenreCache(path).artists.kabat?.tags, ['rock']);
    assert.equal(artistKey('Linkin Park'), artistKey('linkin park'));
  });
});

describe('songNeedsLookup', () => {
  const done = {
    genre: 'rock' as const,
    deezerGenres: ['Alternative'],
    deezerArtist: 'Linkin Park',
  };

  it('retries a Deezer miss after 7 days, and an old row that has no raw genres', () => {
    const miss = { missedAt: new Date(NOW).toISOString() };
    assert.equal(songNeedsLookup(undefined, undefined, NOW), true);
    assert.equal(songNeedsLookup(miss, undefined, NOW + GENRE_MISS_MS - 1), false);
    assert.equal(songNeedsLookup(miss, undefined, NOW + GENRE_MISS_MS), true);
    assert.equal(songNeedsLookup({ missedAt: 'not-a-date' }, undefined, NOW), true);
    assert.equal(songNeedsLookup({ genre: 'indie', deezerArtistId: 9 }, undefined, NOW), true);
    assert.equal(songNeedsLookup(done, { country: 'US', tags: [] }, NOW), false);
    assert.equal(songNeedsLookup(done, { country: 'US', tags: ['rock'] }, NOW), true);
    assert.equal(
      songNeedsLookup(done, { country: 'US', tags: [{ name: 'rock', count: 3 }] }, NOW),
      false,
    );
    assert.equal(songNeedsLookup(done, { country: 'CZ' }, NOW), true);
  });

  it('counts only songs that already have a genre', () => {
    const cache: GenreCacheFile = {
      version: 1,
      songs: {
        a: { genre: 'rock' },
        b: { missedAt: new Date(NOW).toISOString() },
        c: { deezerGenres: ['Pop'] },
      },
      artists: {},
    };
    assert.equal(knownSongs(cache, [{ key: 'a' }, { key: 'b' }, { key: 'c' }]), 1);
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

  it('allows more finds when the shelf has fewer than five fresh songs', () => {
    assert.equal(findAllowance(2, 5), 2);
    assert.equal(findAllowance(2, 1), 3);
    assert.equal(findAllowance(0, 0), 3);
    assert.equal(findAllowance(0, 4), 1);
    assert.equal(kitchenSlots(5, 2), 3);
    assert.equal(kitchenSlots(1, 2), 1);
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

  it('does not promise an hour', () => {
    for (const line of Object.values(readLineFile('en').lines).flat()) {
      assert.equal(/\bhours?\b/i.test(line), false, line);
      assert.equal(/60 minutes/i.test(line), false, line);
    }
    for (const line of Object.values(readLineFile('cs').lines).flat()) {
      assert.equal(/hodin/i.test(line), false, line);
    }
  });
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

  it('reads tags from the matching artist, even when that hit has no country', () => {
    const tagged = {
      artists: [
        { name: 'Kabát', score: 40, country: 'US', tags: [{ count: 1, name: 'pop' }] },
        {
          name: 'Kabát',
          score: 90,
          tags: [
            { count: 2, name: 'rock' },
            { count: 1, name: 'czech' },
          ],
        },
      ],
    };
    assert.deepEqual(artistFromSearch(tagged, 'Kabát'), {
      country: null,
      tags: [
        { name: 'rock', count: 2 },
        { name: 'czech', count: 1 },
      ],
      areaIds: [],
    });
    assert.equal(artistFromSearch({ error: 'nope' }, 'Kabát'), null);
    assert.deepEqual(artistFromSearch({ artists: [{ name: 'Other', country: 'US' }] }, 'Kabát'), {
      country: null,
      tags: [],
      areaIds: [],
    });
  });

  it('keeps a city with no ISO code so the country can be walked from it', () => {
    const city = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
    const birth = 'a640b45c-c173-49b1-8030-973603e895b5';
    const profile = artistFromSearch(
      {
        artists: [
          {
            name: 'Yzomandias',
            score: 100,
            area: { id: city, name: 'Karlovy Vary', type: 'City' },
            'begin-area': { id: birth, name: 'Karlovy Vary', type: 'City' },
            tags: [{ name: 'hip hop', count: '4' }],
          },
        ],
      },
      'Yzomandias',
    );
    assert.deepEqual(profile, {
      country: null,
      tags: [{ name: 'hip hop', count: 4 }],
      areaIds: [city, birth],
    });
    assert.equal(
      artistFromSearch(
        {
          artists: [
            {
              name: 'Yzomandias',
              score: 100,
              area: { id: city, name: 'Karlovy Vary' },
              'begin-area': { id: birth, 'iso-3166-1-codes': ['CZ'] },
            },
          ],
        },
        'Yzomandias',
      )?.country,
      'CZ',
    );
  });

  it('walks a backward part-of relation up to a country and skips the areas inside', () => {
    const city = '39965a97-1571-47b2-a9cd-287cae265dcb';
    const district = '1e68b6de-c758-41b4-9143-0a374ae452f3';
    const country = '51d34c28-61bf-3d21-849f-7492672a9d44';
    assert.deepEqual(
      areaStepFromLookup({
        id: city,
        name: 'Karlovy Vary',
        type: 'City',
        relations: [
          {
            type: 'part of',
            direction: 'backward',
            area: { id: district, name: 'Karlovy Vary', 'iso-3166-2-codes': ['CZ-412'] },
          },
          {
            type: 'part of',
            direction: 'forward',
            area: { id: country, name: 'A place inside the city' },
          },
          { type: 'part of', area: { id: district, name: 'Old forward shape' } },
        ],
      }),
      { country: null, parents: [{ id: district, country: null }] },
    );
    assert.deepEqual(
      areaStepFromLookup({
        id: district,
        type: 'Subdivision',
        'iso-3166-2-codes': ['CZ-KA'],
        relations: [
          {
            type: 'part of',
            direction: 'backward',
            area: { id: country, name: 'Czechia', 'iso-3166-1-codes': ['CZ'] },
          },
        ],
      }),
      { country: null, parents: [{ id: country, country: 'CZ' }] },
    );
    assert.deepEqual(
      areaStepFromLookup({ id: country, 'iso-3166-1-codes': ['CZ'], relations: [] }),
      {
        country: 'CZ',
        parents: [],
      },
    );
    assert.equal(areaStepFromLookup({ error: 'busy' }), null);
  });
});

describe('fetchMusicBrainz', () => {
  it('retries a 503 after 3 seconds, at most twice', async () => {
    const waits: number[] = [];
    let fetches = 0;
    let gates = 0;
    const body = await fetchMusicBrainz(
      async () => {
        fetches += 1;
        if (fetches < 3) return new Response('busy', { status: 503 });
        return Response.json({ artists: [{ name: 'Kabát' }] });
      },
      'https://musicbrainz.example/ws/2/artist',
      { 'User-Agent': 'test' },
      async () => {
        gates += 1;
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(fetches, 3);
    assert.equal(gates, 3);
    assert.deepEqual(waits, [MB_RETRY_MS, MB_RETRY_MS]);
    assert.deepEqual(body, { artists: [{ name: 'Kabát' }] });
  });

  it('gives up after the third 503 and does not retry any other status', async () => {
    let busy = 0;
    const givenUp = await fetchMusicBrainz(
      async () => {
        busy += 1;
        return new Response('busy', { status: 503 });
      },
      'https://musicbrainz.example/ws/2/artist',
      {},
      async () => {},
      async () => {},
    );
    assert.equal(busy, 3);
    assert.equal(givenUp, null);

    const waits: number[] = [];
    let errors = 0;
    const failed = await fetchMusicBrainz(
      async () => {
        errors += 1;
        return new Response('nope', { status: 500 });
      },
      'https://musicbrainz.example/ws/2/artist',
      {},
      async () => {},
      async (ms) => {
        waits.push(ms);
      },
    );
    assert.equal(errors, 1);
    assert.deepEqual(waits, []);
    assert.equal(failed, null);
  });
});

function bookPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'fm-book-')), 'fm-genres.json');
}

/** A catalog whose unimplemented calls fail the test that reached them. */
function catalog(overrides: Partial<FmCatalog>): FmCatalog {
  const unused = async (): Promise<never> => {
    throw new Error('unexpected catalog call');
  };
  return {
    searchTrack: unused,
    albumGenres: unused,
    relatedArtists: async () => [],
    topTracks: async () => [],
    artistCountry: unused,
    lookupArea: async () => ({ ok: true, value: { country: null, parents: [] } }),
    ...overrides,
  };
}

/** Wait until `done`, then a moment so a lookup queued behind it can finish. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Long enough for a lookup that should not start to have started if it was going to. */
function quiet(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe('GenreBook', () => {
  const logger = new Logger('error');

  it('classifies a song in the background and does not file a Deezer miss as other', async () => {
    const path = bookPath();
    const calls: string[] = [];
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack(artist) {
          calls.push(artist);
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
        async artistCountry() {
          return { ok: true, value: { country: 'US', tags: [] } };
        },
      }),
      logger,
    );
    const songs = [
      { key: 'linkin park|numb', artist: 'Linkin Park', title: 'Numb' },
      { key: 'missing|song', artist: 'Missing', title: 'Song' },
      { key: 'offline|song', artist: 'Offline', title: 'Song' },
    ];
    book.enqueue(songs);
    await until(() => book.snapshot().songs['missing|song']?.missedAt !== undefined);
    assert.equal(book.genreOf('linkin park|numb'), 'rock');
    assert.equal(book.artistId('linkin park|numb'), 9);
    assert.deepEqual(book.snapshot().songs['linkin park|numb']?.deezerGenres, ['Rock']);
    assert.equal(book.genreOf('missing|song'), undefined);
    assert.equal(book.snapshot().songs['missing|song']?.genre, undefined);
    assert.equal(book.genreOf('offline|song'), undefined);
    assert.equal(book.ready(songs), false);
    assert.equal(book.ready([{ key: 'linkin park|numb' }]), true);
    book.enqueue(songs);
    await until(() => calls.filter((artist) => artist === 'Offline').length >= 2);
    assert.deepEqual(
      calls.filter((artist) => artist === 'Missing'),
      ['Missing'],
    );
    assert.deepEqual(
      calls.filter((artist) => artist === 'Linkin Park'),
      ['Linkin Park'],
    );
    assert.equal(readGenreCache(path).songs['linkin park|numb']?.genre, 'rock');
  });

  it('tries a Deezer miss again after 7 days', async () => {
    const path = bookPath();
    let now = Date.parse('2026-10-01T00:00:00Z');
    let searches = 0;
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack() {
          searches += 1;
          return { ok: true, value: null };
        },
      }),
      logger,
      undefined,
      () => now,
    );
    const songs = [{ key: 'missing|song', artist: 'Missing', title: 'Song' }];
    book.enqueue(songs);
    await until(() => searches === 1);
    const start = Date.parse(book.snapshot().songs['missing|song']?.missedAt ?? '');
    now = start + GENRE_MISS_MS - 1;
    book.enqueue(songs);
    await quiet();
    assert.equal(searches, 1);
    now = start + GENRE_MISS_MS;
    book.enqueue(songs);
    await until(() => searches === 2);
    assert.equal(searches, 2);
    assert.equal(book.genreOf('missing|song'), undefined);
  });

  it('asks MusicBrainz once per artist and stores the country and the tags', async () => {
    const path = bookPath();
    let asked = 0;
    const cache: GenreCacheFile = {
      version: 1,
      songs: {
        'kabat|a': {
          genre: 'cz-pop',
          deezerArtist: 'Kabát',
          deezerArtistId: 1,
          deezerAlbumId: 2,
          deezerGenres: ['Pop'],
        },
        'kabat|b': {
          genre: 'cz-pop',
          deezerArtist: 'Kabát',
          deezerArtistId: 1,
          deezerAlbumId: 2,
          deezerGenres: ['Pop'],
        },
      },
      artists: { [artistKey('Kabát')]: { country: 'CZ' } },
    };
    const book = new GenreBook(
      path,
      catalog({
        async artistCountry(name) {
          asked += 1;
          assert.equal(name, 'Kabát');
          return {
            ok: true,
            value: {
              country: null,
              tags: [
                { name: 'czech', count: 1 },
                { name: 'rock', count: 5 },
              ],
            },
          };
        },
      }),
      logger,
      cache,
    );
    book.enqueue([
      { key: 'kabat|a', artist: 'ignored', title: 'A' },
      { key: 'kabat|b', artist: 'ignored', title: 'B' },
    ]);
    await until(() => book.genreOf('kabat|b') === 'rock');
    assert.equal(asked, 1);
    assert.equal(book.genreOf('kabat|a'), 'rock');
    assert.deepEqual(book.snapshot().artists[artistKey('Kabát')], {
      country: 'CZ',
      tags: [
        { name: 'czech', count: 1 },
        { name: 'rock', count: 5 },
      ],
    });
    book.enqueue([
      { key: 'kabat|a', artist: 'ignored', title: 'A' },
      { key: 'kabat|b', artist: 'ignored', title: 'B' },
    ]);
    await quiet();
    assert.equal(asked, 1);
  });

  it('keeps the Deezer hit when MusicBrainz does not answer', async () => {
    const path = bookPath();
    let searches = 0;
    let albums = 0;
    let asked = 0;
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack() {
          searches += 1;
          return {
            ok: true,
            value: { title: 'Numb', artist: 'Linkin Park', albumId: 4, artistId: 9 },
          };
        },
        async albumGenres() {
          albums += 1;
          return { ok: true, value: ['Alternative'] };
        },
        async artistCountry() {
          asked += 1;
          return { ok: false };
        },
      }),
      logger,
    );
    const songs = [{ key: 'linkin park|numb', artist: 'Linkin Park', title: 'Numb' }];
    book.enqueue(songs);
    await until(() => book.snapshot().songs['linkin park|numb']?.deezerGenres !== undefined);
    assert.equal(searches, 1);
    assert.equal(albums, 1);
    assert.equal(asked, 1);
    assert.equal(book.genreOf('linkin park|numb'), undefined);
    book.enqueue(songs);
    await until(() => asked === 2);
    assert.equal(searches, 1);
    assert.equal(albums, 1);
    assert.deepEqual(book.snapshot().songs['linkin park|numb']?.deezerGenres, ['Alternative']);
  });

  it('does not search Deezer again when the album lookup failed', async () => {
    const path = bookPath();
    let searches = 0;
    let albums = 0;
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack() {
          searches += 1;
          return {
            ok: true,
            value: { title: 'Numb', artist: 'Linkin Park', albumId: 4, artistId: 9 },
          };
        },
        async albumGenres() {
          albums += 1;
          return { ok: false };
        },
      }),
      logger,
    );
    const songs = [{ key: 'linkin park|numb', artist: 'Linkin Park', title: 'Numb' }];
    book.enqueue(songs);
    await until(() => book.snapshot().songs['linkin park|numb']?.deezerAlbumId === 4);
    book.enqueue(songs);
    await until(() => albums === 2);
    assert.equal(searches, 1);
    assert.equal(albums, 2);
  });

  it('remaps stored Deezer genres without calling the network', () => {
    const path = bookPath();
    const cache: GenreCacheFile = {
      version: 1,
      songs: {
        'linkin park|numb': {
          genre: 'indie',
          deezerArtist: 'Linkin Park',
          deezerGenres: ['Alternative'],
        },
        'kabat|mala': {
          genre: 'cz-pop',
          deezerArtist: 'Kabát',
          deezerGenres: ['Pop'],
        },
      },
      artists: {
        [artistKey('Kabát')]: {
          country: 'CZ',
          tags: [
            { name: 'czech', count: 1 },
            { name: 'rock', count: 5 },
          ],
        },
      },
    };
    const book = new GenreBook(path, catalog({}), logger, cache);
    assert.equal(book.genreOf('linkin park|numb'), 'rock');
    assert.equal(book.genreOf('kabat|mala'), 'rock');
    assert.equal(readGenreCache(path).songs['linkin park|numb']?.genre, 'rock');
  });

  it('reclassifies a row saved without raw genres once', async () => {
    const path = bookPath();
    let searches = 0;
    const cache: GenreCacheFile = {
      version: 1,
      songs: { 'linkin park|numb': { genre: 'indie', deezerArtistId: 9 } },
      artists: {},
    };
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack(_artist, title) {
          searches += 1;
          return {
            ok: true,
            value: { title, artist: 'Linkin Park', albumId: 4, artistId: 9 },
          };
        },
        async albumGenres() {
          return { ok: true, value: ['Alternative'] };
        },
        async artistCountry() {
          return { ok: true, value: { country: 'US', tags: [] } };
        },
      }),
      logger,
      cache,
    );
    assert.equal(book.genreOf('linkin park|numb'), 'indie');
    book.enqueue([{ key: 'linkin park|numb', artist: 'Linkin Park', title: 'Numb' }]);
    await until(() => book.genreOf('linkin park|numb') === 'rock');
    assert.equal(searches, 1);
    assert.deepEqual(book.snapshot().songs['linkin park|numb']?.deezerGenres, ['Alternative']);
    book.enqueue([{ key: 'linkin park|numb', artist: 'Linkin Park', title: 'Numb' }]);
    await quiet();
    assert.equal(searches, 1);
  });

  it('looks up the Deezer artist, not the names in the YouTube title', async () => {
    const path = bookPath();
    const asked: string[] = [];
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack(artist, title) {
          assert.equal(artist, 'Yzomandias, Nik Tendo');
          return {
            ok: true,
            value: { title, artist: 'Yzomandias', albumId: 2, artistId: 8 },
          };
        },
        async albumGenres() {
          return { ok: true, value: ['Pop'] };
        },
        async artistCountry(name) {
          asked.push(name);
          return { ok: true, value: { country: 'CZ', tags: [{ name: 'hip hop', count: 4 }] } };
        },
      }),
      logger,
    );
    const key = 'yzomandias|chci te';
    book.enqueue([{ key, artist: 'Yzomandias, Nik Tendo', title: 'Chci tě' }]);
    await until(() => book.genreOf(key) === 'cz-rap');
    assert.deepEqual(asked, ['Yzomandias']);
    assert.equal(book.snapshot().songs[key]?.deezerArtist, 'Yzomandias');
  });

  it('asks again for tags stored as names, then keeps the vote counts', async () => {
    const path = bookPath();
    let asked = 0;
    const cache: GenreCacheFile = {
      version: 1,
      songs: {
        'dragons|believer': {
          genre: 'edm',
          deezerArtist: 'Imagine Dragons',
          deezerArtistId: 3,
          deezerAlbumId: 4,
          deezerGenres: ['Dance'],
        },
      },
      artists: { [artistKey('Imagine Dragons')]: { country: 'US', tags: ['electropop'] } },
    };
    const book = new GenreBook(
      path,
      catalog({
        async artistCountry() {
          asked += 1;
          return {
            ok: true,
            value: {
              country: 'US',
              tags: [
                { name: 'alternative rock', count: 15 },
                { name: 'pop rock', count: 11 },
                { name: 'electropop', count: 2 },
              ],
            },
          };
        },
      }),
      logger,
      cache,
    );
    book.enqueue([{ key: 'dragons|believer', artist: 'Imagine Dragons', title: 'Believer' }]);
    await until(() => book.genreOf('dragons|believer') === 'rock');
    assert.equal(asked, 1);
    book.enqueue([{ key: 'dragons|believer', artist: 'Imagine Dragons', title: 'Believer' }]);
    await quiet();
    assert.equal(asked, 1);
  });

  it('walks a city up to its country, caches the area, and does not look it up again', async () => {
    const path = bookPath();
    const city = '5b11f4ce-a62d-471e-81fc-a69a8278c7da';
    const country = '489ce91b-6658-3307-9877-795b68554c98';
    let lookups = 0;
    const book = new GenreBook(
      path,
      catalog({
        async searchTrack(artist, title) {
          return { ok: true, value: { title, artist, albumId: 2, artistId: 8 } };
        },
        async albumGenres() {
          return { ok: true, value: ['Rap/Hip Hop'] };
        },
        async artistCountry() {
          return {
            ok: true,
            value: { country: null, tags: [{ name: 'hip hop', count: 3 }], areaIds: [city] },
          };
        },
        async lookupArea(id) {
          lookups += 1;
          assert.equal(id, city);
          return {
            ok: true,
            value: { country: null, parents: [{ id: country, country: 'CZ' }] },
          };
        },
      }),
      logger,
    );
    book.enqueue([{ key: 'yzomandias|coupe', artist: 'Yzomandias', title: 'COUPÉ' }]);
    await until(() => book.genreOf('yzomandias|coupe') === 'cz-rap');
    assert.equal(lookups, 1);
    assert.equal(book.snapshot().areas?.[city], 'CZ');
    assert.equal(book.snapshot().areas?.[country], 'CZ');
    book.enqueue([{ key: 'nik tendo|jine', artist: 'Nik Tendo', title: 'Jiné' }]);
    await until(() => book.genreOf('nik tendo|jine') === 'cz-rap');
    assert.equal(lookups, 1);
  });
});
