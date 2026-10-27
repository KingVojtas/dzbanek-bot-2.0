import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import type { FmCatalog } from '../src/fm/catalog';
import { FmStation } from '../src/fm/FmStation';
import type { GenreId, GenreIndex } from '../src/fm/genres';
import { reactionSongKey, tallyReactions, toggleReaction } from '../src/fm/reactions';
import { sidelined, type FmSong } from '../src/fm/script';
import { songFromCatch, songFromTrack } from '../src/quiz/songs';

const START = Date.parse('2026-10-26T17:00:00Z');
const SONG_MS = 200_000;

function kitchenSong(genre: GenreId, n: number, heat?: number): FmSong {
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
    heat,
  };
}

function asTrack(song: Pick<FmSong, 'label' | 'url' | 'durationSec'>): Track {
  return {
    title: song.label,
    url: song.url ?? 'https://youtu.be/none',
    durationSec: song.durationSec,
    requestedBy: 'Vojta',
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
  findBlocks?: () => Promise<readonly { artist: string; title: string }[]>;
  artistId?: (key: string) => number | undefined;
  blockSets?: number;
  /** False: genres are not known yet, so the station plans a themed set. */
  blocks?: boolean;
  genreOf?: (key: string) => GenreId;
  planSet?: (discover: number) => {
    vibe: string;
    line: string;
    songs: { crate: number | null; artist: string; title: string }[];
  } | null;
}) {
  const calls = { deezer: 0, youtube: 0 };
  const genres: GenreIndex = {
    genreOf: opts.genreOf ?? ((key) => key.split('|')[0] as GenreId),
    artistId: opts.artistId ?? (() => 1),
    ready: () => opts.blocks !== false,
    enqueue() {},
  };
  const catalog: FmCatalog = {
    searchTrack: async () => {
      calls.deezer += 1;
      return { ok: true, value: null };
    },
    albumGenres: async () => {
      calls.deezer += 1;
      return { ok: true, value: [] };
    },
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
    artistCountry: async () => {
      calls.deezer += 1;
      return { ok: true, value: { country: null, tags: [] } };
    },
    lookupArea: async () => {
      calls.deezer += 1;
      return { ok: true, value: { country: null, parents: [] } };
    },
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
      writer: (opts.planSet
        ? {
            ready: true,
            planSet: async (facts: { discover: number }) => opts.planSet!(facts.discover),
          }
        : { ready: false }) as never,
      voice: { speak: async () => null } as never,
      language: 'en',
      discover: 2,
      blockSets: opts.blockSets ?? 2,
      genres,
      catalog,
      findBlocks: opts.findBlocks,
      lines: null,
      now: () => clock,
      timezone: 'Europe/Prague',
      logger: quiet as never,
    },
    () => {},
  );
  return {
    calls,
    station,
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

describe('FmStation just played', () => {
  it('does not open the next set with a song a request just started', async () => {
    const hot = kitchenSong('cz-rap', 0, 1_000_000_000);
    const radio = show({
      pool: [hot, ...Array.from({ length: 11 }, (_, n) => kitchenSong('cz-rap', n + 1))],
    });
    radio.station.starting(asTrack(hot));
    const first = await radio.station.upNext();
    assert.ok(first);
    assert.notEqual(first.url, hot.url);
  });

  it('does not open the next set with the song already playing when it goes on air', async () => {
    const playing: Track = {
      title: 'Poet - Pribehy sny',
      url: 'https://youtu.be/different-video',
      durationSec: 200,
      requestedBy: 'Vojta',
    };
    const caught: FmSong = {
      key: songFromTrack(playing, { kind: 'play' }).key,
      artist: 'Poet',
      title: 'Pribehy sny',
      label: 'Poet — Pribehy sny',
      query: 'Poet - Pribehy sny',
      durationSec: 200,
      from: { kind: 'catch', userId: 'u1' },
      at: new Date(START),
      heat: 1_000_000_000,
    };
    const radio = show({
      pool: [caught, ...Array.from({ length: 11 }, (_, n) => kitchenSong('cz-rap', n + 1))],
      genreOf: () => 'cz-rap',
      searchOne: async () => ({
        title: 'CATCH HIT',
        url: 'https://youtu.be/catch-hit',
        durationSec: 200,
        requestedBy: 'Kitchen FM',
      }),
    });
    radio.station.heard(playing);
    const first = await radio.station.upNext();
    assert.ok(first);
    assert.notEqual(first.url, 'https://youtu.be/catch-hit');
    assert.equal(radio.calls.youtube, 0);
  });
});

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
    const opening = await radio.play(5);
    assert.equal(opening.length, 5);
    assert.equal(radio.calls.youtube, 0);
    assert.equal(radio.calls.deezer, 0);
    const next = await radio.play(1);
    const first = next[0];
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
    assert.equal(played.slice(0, 4).filter(kitchen).length, 4);
    assert.ok(played.slice(0, 4).every((song) => !song.vibe?.includes('new find')));
    assert.deepEqual(played.slice(4).filter(kitchen), []);
    assert.ok(played.slice(4).every((song) => song.vibe?.includes('new find')));
  });

  it('does not suggest a new find someone marked 👎', async () => {
    const radio = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      related: [{ id: 7, name: 'Stranger' }],
      tops: [{ title: 'Brand New', artist: 'Stranger', durationSec: 180 }],
      findBlocks: async () => [{ artist: 'Stranger', title: 'Brand New' }],
      searchOne: async (query) => ({
        title: query,
        url: `https://youtu.be/${encodeURIComponent(query)}`,
        durationSec: 200,
        uploader: query.split(' - ')[0] ?? '',
        requestedBy: 'Kitchen FM',
      }),
    });
    const played = await radio.play(8);
    assert.ok(played.length >= 4);
    assert.ok(played.every((song) => !song.title.includes('Brand New')));
    assert.equal(radio.calls.youtube, 0);
  });

  it('plans the first set with no catalog or YouTube calls', async () => {
    const hit = async () => ({
      title: 'Brand New',
      url: 'https://youtu.be/brandnew',
      durationSec: 180,
      uploader: 'Stranger',
      requestedBy: 'Kitchen FM',
    });
    const block = show({
      pool: Array.from({ length: 12 }, (_, n) => kitchenSong('cz-rap', n)),
      related: [{ id: 7, name: 'Stranger' }],
      searchOne: hit,
    });
    const played = await block.play(5);
    assert.equal(played.length, 5);
    assert.equal(block.calls.deezer, 0);
    assert.equal(block.calls.youtube, 0);
    assert.ok(played.every((song) => !song.vibe?.includes('new find')));

    const themed = show({
      pool: Array.from({ length: 12 }, (_, n) => kitchenSong('pop', n)),
      blocks: false,
      related: [{ id: 7, name: 'Stranger' }],
      searchOne: hit,
    });
    const themedPlayed = await themed.play(1);
    assert.equal(themedPlayed.length, 1);
    assert.equal(themed.calls.deezer, 0);
    assert.equal(themed.calls.youtube, 0);

    let discover: number | null = null;
    const claude = show({
      pool: Array.from({ length: 12 }, (_, n) => kitchenSong('rock', n)),
      blocks: false,
      related: [{ id: 9, name: 'Stranger' }],
      searchOne: hit,
      planSet: (value) => {
        discover = value;
        return {
          vibe: 'rock',
          line: 'Hey.',
          songs: [
            { crate: 1, artist: 'rock artist 0', title: 'rock song 0' },
            { crate: null, artist: 'Stranger', title: 'Brand New' },
          ],
        };
      },
    });
    const first = await claude.play(1);
    assert.equal(first.length, 1);
    assert.equal(discover, 0);
    assert.equal(claude.calls.deezer, 0);
    assert.equal(claude.calls.youtube, 0);
    assert.equal(first[0]?.vibe?.includes('new find'), false);
  });
});

describe('FmStation song keys', () => {
  it('stores a 🔥 and a 👎 on a catch under the catch key, and a 👎 sidelines it', async () => {
    const caught = songFromCatch({ artist: 'Viktor Sheen', title: 'Lavazza', userId: 'u1' });
    const pool: FmSong[] = ['Lavazza', 'Pribehy', 'Kids'].map((title, n) => {
      const song = n === 0 ? caught : songFromCatch({ artist: 'Poet', title, userId: 'u1' });
      return {
        ...song,
        durationSec: 200,
        at: new Date(START),
      };
    });
    const radio = show({
      pool,
      blocks: false,
      searchOne: async (query) => ({
        title: 'Untitled clip',
        url: `https://youtu.be/${encodeURIComponent(query)}`,
        durationSec: 200,
        uploader: 'Various Artists - Topic',
        requestedBy: 'Kitchen FM',
      }),
    });
    const track = await radio.station.upNext();
    assert.ok(track);
    const song = pool.find((item) => track.url.endsWith(encodeURIComponent(item.query)));
    assert.ok(song);
    const youtubeKey = songFromTrack(track, { kind: 'play' }).key;
    assert.notEqual(youtubeKey, song.key);
    assert.equal(radio.station.keyOf(track), song.key);

    const key = reactionSongKey(track, radio.station.keyOf(track));
    const target = { songKey: key, url: track.url, title: song.title, artist: song.artist };
    const fire = toggleReaction([], 'listener', target, 'fire');
    assert.equal(fire.rows[0]?.songKey, song.key);
    assert.equal(fire.result.firstFire, true);
    const nope = toggleReaction([], 'listener', target, 'nope');
    assert.equal(nope.rows[0]?.songKey, song.key);
    const tally = tallyReactions(nope.rows);
    assert.equal(
      sidelined({ heat: tally.fires.get(song.key) ?? 0, nopes: tally.nopes.get(song.key) ?? 0 }),
      true,
    );
    assert.equal(tally.nopes.has(youtubeKey), false);
  });

  it('remembers a new find under the key a play of that hit would get', async () => {
    const hit = {
      title: 'Stranger - Brand New (Official Video)',
      url: 'https://youtu.be/brand-new',
      durationSec: 180,
      uploader: 'StrangerVEVO',
      requestedBy: 'Kitchen FM',
    };
    const radio = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      related: [{ id: 7, name: 'Stranger' }],
      tops: [{ title: 'Brand New', artist: 'Stranger', durationSec: 180 }],
      searchOne: async () => ({ ...hit }),
    });
    for (let i = 0; i < 10; i += 1) {
      const track = await radio.station.upNext();
      assert.ok(track);
      if (track.url === hit.url) {
        assert.equal(radio.station.keyOf(track), songFromTrack(track, { kind: 'play' }).key);
        return;
      }
      radio.station.starting(track);
    }
    assert.fail('the new find never played');
  });
});
