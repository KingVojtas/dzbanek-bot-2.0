import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FmCatalog } from '../src/fm/catalog';
import { FmStation } from '../src/fm/FmStation';
import type { GenreId, GenreIndex } from '../src/fm/genres';
import type { FmSong } from '../src/fm/script';

const START = Date.parse('2026-10-26T17:00:00Z');
const SONG_MS = 200_000;

function kitchenSong(genre: GenreId, n: number): FmSong {
  return {
    key: `${genre}|${n}`,
    artist: `${genre} artist ${n}`,
    title: `${genre} song ${n}`,
    label: `${genre} artist ${n} — ${genre} song ${n}`,
    query: `${genre} artist ${n} - ${genre} song ${n}`,
    url: `https://youtu.be/${genre}${n}`,
    durationSec: SONG_MS / 1000,
    from: { kind: 'play', userId: 'u1' },
    at: new Date(START - n * 86_400_000),
  };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A show with fake Discord, Deezer, and YouTube, and a clock that moves one song at a time. */
function show(opts: {
  pool: FmSong[];
  related?: { id: number; name: string }[] | ((seedId: number) => { id: number; name: string }[]);
  tops?: { title: string; artist: string; durationSec: number }[];
  topsFor?: (artistId: number) => { title: string; artist: string; durationSec: number }[];
  searchOne?: (query: string) => Promise<unknown>;
  artistId?: (key: string) => number | undefined;
  blockSets?: number;
}) {
  const calls = { deezer: 0, youtube: 0 };
  const genres: GenreIndex = {
    genreOf: (key) => key.split('|')[0] as GenreId,
    artistId: opts.artistId ?? (() => 1),
    ready: () => true,
    enqueue() {},
  };
  const catalog: FmCatalog = {
    searchTrack: async () => ({ ok: true, value: null }),
    albumGenres: async () => ({ ok: true, value: [] }),
    relatedArtists: async (seedId) => {
      calls.deezer += 1;
      if (typeof opts.related === 'function') return opts.related(seedId);
      return opts.related ?? [];
    },
    topTracks: async (artistId: number) => {
      calls.deezer += 1;
      if (opts.topsFor) return opts.topsFor(artistId);
      return opts.tops ?? [{ title: 'Brand New', artist: 'Stranger', durationSec: 200 }];
    },
    artistCountry: async () => ({ ok: true, value: { country: null, tags: [] } }),
    lookupArea: async () => ({ ok: true, value: { country: null, parents: [] } }),
  };
  let clock = START;
  const members = [{ id: 'u1', displayName: 'Vojta' }];
  const station = new FmStation(
    {
      guild: {
        name: 'Kitchen',
        members: { cache: new Map(members.map((m) => [m.id, m])), fetch: async () => null },
      } as never,
      listeners: () => members as never,
      pool: async () => opts.pool,
      source: {
        youtube: {
          searchOne: async (query: string) => {
            calls.youtube += 1;
            return (opts.searchOne ?? (async () => null))(query);
          },
        },
      } as never,
      writer: { ready: false } as never,
      voice: { speak: async () => null } as never,
      language: 'en',
      discover: 2,
      blockSets: opts.blockSets ?? 2,
      genres,
      catalog,
      lines: null,
      now: () => clock,
      timezone: 'Europe/Prague',
      logger: quiet as never,
    },
    () => {},
  );
  return {
    calls,
    /** Play `count` songs; stops early when the station has nothing. */
    async play(count: number): Promise<{ title: string; vibe: string | null }[]> {
      const played: { title: string; vibe: string | null }[] = [];
      for (let i = 0; i < count; i += 1) {
        const track = await station.upNext();
        if (!track) break;
        station.starting(track);
        played.push({ title: track.title, vibe: station.vibeOf(track) });
        clock += SONG_MS;
      }
      return played;
    },
  };
}

describe('FmStation genre blocks', () => {
  it('keeps playing when the YouTube search for a new find throws', async () => {
    const radio = show({
      pool: Array.from({ length: 12 }, (_, n) => kitchenSong('cz-rap', n)),
      related: [{ id: 7, name: 'Stranger' }],
      searchOne: async () => {
        throw new Error('Sign in to confirm you are not a bot');
      },
    });
    const played = await radio.play(6);
    assert.equal(played.length, 6);
  });

  it('gives no block to a genre with one song, and repeats nothing inside a block', async () => {
    const radio = show({
      pool: [
        ...Array.from({ length: 20 }, (_, n) => kitchenSong('cz-rap', n)),
        kitchenSong('metal', 99),
      ],
    });
    const played = await radio.play(20);
    assert.ok(played.length >= 18);
    assert.ok(played.every((song) => song.vibe !== 'metal'));
    const rap = played.filter((song) => song.vibe === 'Czech rap').map((song) => song.title);
    assert.equal(new Set(rap).size, rap.length);
  });

  it('labels every song of a block with its own genre', async () => {
    const radio = show({
      pool: [
        ...Array.from({ length: 12 }, (_, n) => kitchenSong('cz-rap', n)),
        ...Array.from({ length: 8 }, (_, n) => kitchenSong('rock', n)),
      ],
    });
    for (const song of await radio.play(20)) {
      if (song.vibe === 'Czech rap') assert.match(song.title, /cz-rap/);
      if (song.vibe === 'rock') assert.match(song.title, /rock/);
    }
  });

  it('stops looking after 4 YouTube searches and 8 Deezer calls, and still plays the kitchen', async () => {
    const radio = show({
      pool: Array.from({ length: 12 }, (_, n) => kitchenSong('cz-rap', n)),
      artistId: (key) => 100 + Number(key.split('|')[1]),
      related: (seedId) => [{ id: seedId + 1000, name: `Stranger ${seedId}` }],
      tops: [{ title: 'Fresh Cut', artist: 'Outside', durationSec: 180 }],
      searchOne: async () => null,
    });
    const played = await radio.play(1);
    const first = played[0];
    assert.ok(first);
    assert.match(first.title, /cz-rap/);
    assert.equal(radio.calls.youtube, 4);
    assert.equal(radio.calls.deezer, 8);
  });

  it('opens with one set, then plays the next genre for blockSets sets', async () => {
    const radio = show({
      pool: [
        ...Array.from({ length: 12 }, (_, n) => kitchenSong('cz-rap', n)),
        ...Array.from({ length: 12 }, (_, n) => kitchenSong('rock', n)),
      ],
      blockSets: 2,
      searchOne: async () => null,
    });
    const played = await radio.play(15);
    const vibe = played.map((song) => song.vibe?.replace(/ · new find$/, '') ?? '');
    assert.deepEqual(vibe.slice(0, 5), Array(5).fill('Czech rap'));
    assert.deepEqual(vibe.slice(5, 15), Array(10).fill('rock'));
  });

  it('plays 20 songs from a 4-song kitchen without repeating one inside any 10', async () => {
    const radio = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      artistId: (key) => 1000 + Number(key.split('|')[1]),
      related: (seedId) =>
        Array.from({ length: 8 }, (_, i) => ({
          id: seedId * 20 + i + 1,
          name: `Rel ${seedId}-${i}`,
        })),
      topsFor: (artistId) => [
        { title: `Find ${artistId}`, artist: `Artist ${artistId}`, durationSec: 180 },
      ],
      searchOne: async (query) => ({
        title: query,
        url: `https://youtu.be/${encodeURIComponent(query)}`,
        durationSec: 200,
        uploader: query.split(' - ')[0] ?? '',
        requestedBy: 'Kitchen FM',
      }),
    });
    const played = await radio.play(20);
    assert.equal(played.length, 20);
    for (let i = 0; i <= played.length - 10; i += 1) {
      const window = played.slice(i, i + 10).map((song) => song.title);
      assert.equal(new Set(window).size, window.length, window.join(' | '));
    }
  });

  it('plays a small kitchen once, then only new finds from similar artists', async () => {
    const radio = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      artistId: (key) => 1000 + Number(key.split('|')[1]),
      related: (seedId) =>
        Array.from({ length: 8 }, (_, i) => ({
          id: seedId * 20 + i + 1,
          name: `Rel ${seedId}-${i}`,
        })),
      topsFor: (artistId) => [
        { title: `Find ${artistId}`, artist: `Artist ${artistId}`, durationSec: 180 },
      ],
      searchOne: async (query) => ({
        title: query,
        url: `https://youtu.be/${encodeURIComponent(query)}`,
        durationSec: 200,
        uploader: query.split(' - ')[0] ?? '',
        requestedBy: 'Kitchen FM',
      }),
    });
    const played = await radio.play(15);
    assert.equal(played.length, 15);
    const kitchen = (song: { title: string }) => song.title.includes('pop song');
    assert.equal(played.slice(0, 5).filter(kitchen).length, 4);
    assert.deepEqual(played.slice(5).filter(kitchen), []);
  });
});
