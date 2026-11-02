import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '../src/core/logger';
import type { Track } from '../src/core/types';
import type { FmCatalog } from '../src/fm/catalog';
import type { GenreIndex } from '../src/fm/genres';
import type { FmSong, OpenerSong } from '../src/fm/script';
import { StationDiscover, type StationDiscoverDeps } from '../src/fm/station-discover';

const index: GenreIndex = {
  genreOf: () => undefined,
  artistId: () => 42,
  ready: () => true,
  enqueue: () => {},
};

function kitchen(artist: string, title: string): FmSong {
  return {
    key: `${artist}|${title}`,
    label: `${artist} – ${title}`,
    artist,
    title,
    query: `${artist} - ${title}`,
    durationSec: 200,
    at: new Date(0),
    from: { kind: 'play' },
  };
}

/** A YouTube hit whose title is the search query, so `isSameSong` accepts it. */
function hit(query: string): Track {
  return {
    title: query,
    url: `https://youtu.be/${encodeURIComponent(query)}`,
    durationSec: 200,
    uploader: query.split(' - ')[0] ?? '',
    requestedBy: 'Kitchen FM',
  };
}

interface Recorded {
  placed: Track[];
  dead: { artist: string; title: string }[];
  remembered: Track[];
  about: { hit: Track; about: OpenerSong }[];
  infos: string[];
  warns: unknown[][];
}

function recorded(): Recorded {
  return { placed: [], dead: [], remembered: [], about: [], infos: [], warns: [] };
}

function findsFor(book: Recorded, patch: Partial<StationDiscoverDeps> = {}): StationDiscover {
  const log = {
    info: (message: string) => book.infos.push(message),
    warn: (...args: unknown[]) => book.warns.push(args),
    debug() {},
    error() {},
  } as unknown as Logger;
  return new StationDiscover({
    youtube: { searchOne: async () => null },
    ended: () => false,
    oneSong: () => false,
    played: () => [],
    deadList: () => [],
    airedRows: () => [],
    urlTaken: () => false,
    noteDead: (artist, title) => book.dead.push({ artist, title }),
    place: (tracks, track) => {
      tracks.push(track);
      book.placed.push(track);
    },
    rememberFind: (found) => book.remembered.push(found),
    aboutSet: (found, about) => book.about.push({ hit: found, about }),
    ...patch,
    logger: patch.logger ?? log,
  });
}

describe('StationDiscover playlists', () => {
  it('places hits in the order searches started, and stops at the allowance', async () => {
    const book = recorded();
    const pending: {
      query: string;
      resolve: (track: Track | null) => void;
    }[] = [];
    const songs = [
      { artist: 'Daft Punk', title: 'Digital Love', durationSec: 200 },
      { artist: 'Daft Punk', title: 'One More Time', durationSec: 200 },
      { artist: 'Justice', title: 'Genesis', durationSec: 200 },
    ];
    const into: Track[] = [];
    const finds = findsFor(book, {
      genreTracks: async () => songs,
      youtube: {
        searchOne: (query) =>
          new Promise((resolve) => {
            pending.push({ query, resolve });
          }),
      },
    });
    const running = finds.addPlaylist('rock', [], into, 2);
    for (let i = 0; i < 30 && pending.length < 3; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(pending.length, 3);
    const started = pending.map((item) => item.query);
    pending[2]!.resolve(hit(pending[2]!.query));
    pending[1]!.resolve(hit(pending[1]!.query));
    pending[0]!.resolve(hit(pending[0]!.query));
    await running;
    assert.deepEqual(
      book.placed.map((track) => track.title),
      started.slice(0, 2),
    );
    assert.deepEqual(
      into.map((track) => track.title),
      started.slice(0, 2),
    );
    assert.equal(book.remembered.length, 2);
    assert.equal(book.dead.length, 0);
    assert.deepEqual(
      book.infos,
      started.slice(0, 2).map((query) => `Kitchen FM: new find "${query}".`),
    );
    assert.equal(
      book.placed.every((track) => track.stationPick === true),
      true,
    );
    assert.deepEqual(
      book.about.map((item) => item.about.how),
      ['new', 'new'],
    );
  });

  it('searches without the release label, and notes the Deezer title when YouTube misses', async () => {
    const book = recorded();
    const queries: string[] = [];
    const finds = findsFor(book, {
      genreTracks: async () => [
        { artist: 'Deep Purple', title: 'Smoke On The Water (Remastered 2012)', durationSec: 200 },
      ],
      youtube: {
        searchOne: async (query) => {
          queries.push(query);
          return null;
        },
      },
    });
    const into: Track[] = [];
    await finds.addPlaylist('rock', [], into, 1);
    assert.equal(into.length, 0);
    assert.deepEqual(queries, ['Deep Purple - Smoke On The Water']);
    assert.deepEqual(book.dead, [
      { artist: 'Deep Purple', title: 'Smoke On The Water (Remastered 2012)' },
    ]);
    assert.deepEqual(book.infos, [
      'Kitchen FM: no YouTube match for the new find "Deep Purple - Smoke On The Water (Remastered 2012)".',
    ]);
    assert.equal(book.remembered.length, 0);
  });

  it('does not retire a find when the YouTube search throws', async () => {
    const book = recorded();
    const finds = findsFor(book, {
      genreTracks: async () => [{ artist: 'Daft Punk', title: 'Digital Love', durationSec: 200 }],
      youtube: {
        searchOne: async () => {
          throw new Error('down');
        },
      },
    });
    const into: Track[] = [];
    await finds.addPlaylist('rock', [], into, 1);
    assert.equal(into.length, 0);
    assert.equal(book.dead.length, 0);
    assert.equal(book.infos.length, 0);
    assert.equal(book.warns.length, 1);
    assert.match(
      String(book.warns[0]?.[0]),
      /YouTube search failed for "Daft Punk - Digital Love"/,
    );
  });

  it('treats an already-aired upload as a dead find', async () => {
    const book = recorded();
    const finds = findsFor(book, {
      genreTracks: async () => [{ artist: 'Daft Punk', title: 'Digital Love', durationSec: 200 }],
      youtube: { searchOne: async (query) => hit(query) },
      urlTaken: () => true,
    });
    const into: Track[] = [];
    await finds.addPlaylist('rock', [], into, 1);
    assert.equal(into.length, 0);
    assert.equal(book.remembered.length, 0);
    assert.deepEqual(book.dead, [{ artist: 'Daft Punk', title: 'Digital Love' }]);
    assert.deepEqual(book.infos, ['Kitchen FM: "Daft Punk - Digital Love" already aired.']);
  });

  it('warns and places nothing when the playlist will not load', async () => {
    const book = recorded();
    let searched = 0;
    const finds = findsFor(book, {
      genreTracks: async () => {
        throw new Error('deezer');
      },
      youtube: {
        searchOne: async () => {
          searched += 1;
          return null;
        },
      },
    });
    const into: Track[] = [];
    await finds.addPlaylist('rock', [], into, 2);
    assert.equal(into.length, 0);
    assert.equal(searched, 0);
    assert.equal(book.warns.length, 1);
    assert.match(String(book.warns[0]?.[0]), /could not load playlist tracks for rock/);
  });
});

describe('StationDiscover related artists', () => {
  it('reuses a Deezer answer for the rest of the show, and asks again when that answer was empty', async () => {
    const book = recorded();
    const relatedIds: number[] = [];
    const topIds: number[] = [];
    const searches: string[] = [];
    const finds = findsFor(book, {
      catalog: {
        relatedArtists: async (id: number) => {
          relatedIds.push(id);
          if (id !== 42) return [];
          return [{ id: 99, name: 'Justice' }];
        },
        topTracks: async (id: number) => {
          topIds.push(id);
          if (id !== 99) return [];
          return [{ artist: 'Justice', title: 'Genesis', durationSec: 180 }];
        },
      } as unknown as FmCatalog,
      youtube: {
        searchOne: async (query) => {
          searches.push(query);
          return hit(query);
        },
      },
    });
    const pool = [kitchen('Daft Punk', 'Digital Love')];
    const first = await finds.discover(pool, null, 1, new Set(), index);
    const second = await finds.discover(pool, null, 1, new Set(), index);
    assert.deepEqual(relatedIds, [42, 99, 99]);
    assert.deepEqual(topIds, [99, 42, 42]);
    assert.deepEqual(searches, ['Justice - Genesis', 'Justice - Genesis']);
    assert.equal(first[0]?.title, 'Justice - Genesis');
    assert.equal(first[0]?.stationPick, true);
    assert.equal(second[0]?.stationPick, true);
    assert.equal(book.remembered.length, 2);
    assert.deepEqual(
      book.about.map((item) => item.about),
      [
        { artist: 'Justice', title: 'Genesis', by: null, how: 'new' },
        { artist: 'Justice', title: 'Genesis', by: null, how: 'new' },
      ],
    );
  });
});
