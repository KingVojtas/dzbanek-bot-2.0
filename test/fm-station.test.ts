import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import type { FmCatalog } from '../src/fm/catalog';
import { FmStation } from '../src/fm/FmStation';
import type { GenreId, GenreIndex } from '../src/fm/genres';
import { reactionSongKey, tallyReactions, toggleReaction } from '../src/fm/reactions';
import { sidelined, type FmSong } from '../src/fm/script';
import { songFromCatch, songFromTrack } from '../src/quiz/songs';
import type { AiredSong } from '../src/quiz/stores';

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

/** A show with fake Discord, Deezer, and YouTube, and a clock that moves one song at a time. */
function show(opts: {
  pool: FmSong[];
  related?: { id: number; name: string }[] | ((seedId: number) => { id: number; name: string }[]);
  tops?: { title: string; artist: string; durationSec: number }[];
  topsFor?: (artistId: number) => { title: string; artist: string; durationSec: number }[];
  searchOne?: (query: string) => Promise<unknown>;
  findBlocks?: () => Promise<readonly { artist: string; title: string }[]>;
  /** Songs already aired, read again for every set. */
  aired?: () => Promise<readonly AiredSong[]>;
  /** Lines `logger.warn` was given. */
  warns?: string[];
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
  speak?: (text: string) => Promise<Buffer | null>;
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
      voice: { speak: opts.speak ?? (async () => null) } as never,
      language: 'en',
      discover: 2,
      blockSets: opts.blockSets ?? 2,
      genres,
      catalog,
      findBlocks: opts.findBlocks,
      aired: opts.aired,
      lines: null,
      now: () => clock,
      timezone: 'Europe/Prague',
      logger: {
        debug() {},
        info() {},
        warn(...args: unknown[]) {
          opts.warns?.push(args.map((part) => String(part)).join(' '));
        },
        error() {},
      } as never,
    },
    () => {},
  );
  return {
    calls,
    station,
    /** Play `count` songs; stops early when the station has nothing. */
    async play(count: number): Promise<{ title: string; url: string; vibe: string | null }[]> {
      const played: { title: string; url: string; vibe: string | null }[] = [];
      for (let i = 0; i < count; i += 1) {
        const track = await station.upNext();
        if (!track) break;
        station.starting(track);
        played.push({ title: track.title, url: track.url, vibe: station.vibeOf(track) });
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

  it('searches one dead find, spends the finds-only Deezer cap, and still plays the kitchen', async () => {
    // Twelve songs: the opening set keeps five, and seven unaired is under the
    // small-kitchen line, so the next set is finds only (allowance 5). The cap
    // is 5*4+4 Deezer calls. Every stranger shares one top, so YouTube is asked
    // once and that miss blocks the rest.
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
    assert.equal(radio.calls.youtube, 1);
    assert.equal(radio.calls.deezer, 24);
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

describe('FmStation voice cache', () => {
  const pool = [1, 2, 3, 4, 5, 6].map((n) => kitchenSong('rock', n));

  it('retries a failed set line on the next intro', async () => {
    let calls = 0;
    const radio = show({
      pool,
      blocks: false,
      speak: async () => {
        calls += 1;
        return calls === 1 ? null : Buffer.alloc(4, 9);
      },
    });
    const track = await radio.station.upNext();
    assert.ok(track);
    assert.equal(calls, 1);
    const again = await radio.station.intro(track);
    assert.equal(calls, 2);
    assert.equal(again?.pcm?.[0], 9);
    const cached = await radio.station.intro(track);
    assert.equal(calls, 2);
    assert.equal(cached?.pcm, again?.pcm);
  });

  it('shares one synthesis between two intros asked together', async () => {
    let release: (pcm: Buffer | null) => void = () => {};
    let calls = 0;
    const radio = show({
      pool,
      blocks: false,
      speak: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const track = await radio.station.upNext();
    assert.ok(track);
    assert.equal(calls, 1);
    const early = radio.station.intro(track);
    const again = radio.station.intro(track);
    assert.equal(calls, 1);
    release(null);
    const [left, right] = await Promise.all([early, again]);
    assert.equal(left?.pcm, null);
    assert.equal(right?.pcm, null);

    const retryA = radio.station.intro(track);
    const retryB = radio.station.intro(track);
    assert.equal(calls, 2);
    release(Buffer.alloc(4, 7));
    const [a, b] = await Promise.all([retryA, retryB]);
    assert.equal(a?.pcm?.[0], 7);
    assert.equal(b, a);
  });

  it('retries a dedication that came back without a clip, once for both callers', async () => {
    let dedicationTries = 0;
    const radio = show({
      pool,
      blocks: false,
      speak: async (text) => {
        if (!text.includes('good luck')) return Buffer.alloc(4, 2);
        dedicationTries += 1;
        return dedicationTries === 1 ? null : Buffer.alloc(4, 1);
      },
    });
    const track = await radio.station.upNext();
    assert.ok(track);
    radio.station.dedicate({
      userId: 'u1',
      from: 'Vojta',
      to: '',
      message: 'good luck',
      track,
      song: '',
    });
    await new Promise((resolve) => setImmediate(resolve));
    radio.station.starting(track);
    const left = radio.station.intro(track);
    const right = radio.station.intro(track);
    const [a, b] = await Promise.all([left, right]);
    assert.equal(dedicationTries, 2);
    assert.equal(a, b);
    assert.equal(a?.pcm?.[0], 1);
  });
});

/** A YouTube hit whose title is the search query, so `isSameSong` accepts it. */
function found(query: string, url?: string): Track {
  return {
    title: query,
    url: url ?? `https://youtu.be/${encodeURIComponent(query)}`,
    durationSec: 200,
    uploader: query.split(' - ')[0] ?? '',
    requestedBy: 'Kitchen FM',
  };
}

function airedOf(song: FmSong, playedAt: Date, patch: Partial<AiredSong> = {}): AiredSong {
  return {
    songKey: song.key,
    url: song.url ?? '',
    artist: song.artist,
    title: song.title,
    playedAt,
    ...patch,
  };
}

/** Four new artists per Deezer id, with ids that never collide across rings. */
function wideRelated(id: number): { id: number; name: string }[] {
  return [1, 2, 3, 4].map((n) => ({ id: id * 10 + n, name: `Rel ${id}-${n}` }));
}

describe('FmStation never repeats an aired song', () => {
  it('leaves an earlier show’s songs out while the kitchen still has unaired ones', async () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => kitchenSong('pop', n));
    const byKey = pool[0]!;
    const byUrl = pool[1]!;
    const aired: AiredSong[] = [
      airedOf(byKey, new Date(START - 86_400_000), { url: '' }),
      airedOf(byUrl, new Date(START - 2 * 86_400_000), { songKey: 'not-the-pool-key' }),
    ];
    const radio = show({
      pool,
      aired: async () => aired,
      artistId: (key) => 300 + Number(key.split('|')[1]),
      related: wideRelated,
      topsFor: (artistId) => [
        { title: `Cut ${artistId}`, artist: `Band ${artistId}`, durationSec: 180 },
      ],
      searchOne: async (query) => found(query),
    });
    const played = await radio.play(10);
    assert.equal(played.length, 10);
    const urls = played.map((song) => song.url);
    assert.equal(urls.includes(byKey.url!), false);
    assert.equal(urls.includes(byUrl.url!), false);
    assert.ok(pool.slice(2).some((song) => urls.includes(song.url!)));
  });

  it('plays ten sets from a 6-song kitchen without repeating a url or a title', async () => {
    const warns: string[] = [];
    const radio = show({
      pool: [1, 2, 3, 4, 5, 6].map((n) => kitchenSong('pop', n)),
      warns,
      artistId: (key) => 100 + Number(key.split('|')[1]),
      related: wideRelated,
      topsFor: (artistId) => [{ title: `T${artistId}`, artist: `A${artistId}`, durationSec: 180 }],
      searchOne: async (query) => found(query),
    });
    const played = await radio.play(50);
    assert.equal(played.length, 50);
    assert.equal(new Set(played.map((song) => song.url)).size, played.length);
    assert.equal(new Set(played.map((song) => song.title)).size, played.length);
    assert.equal(
      warns.some((line) => line.includes('nothing new')),
      false,
    );
  });

  it('fills a fully aired kitchen with finds, including the second ring', async () => {
    const pool = [1, 2, 3, 4].map((n) => kitchenSong('pop', n));
    const radio = show({
      pool,
      aired: async () => pool.map((song) => airedOf(song, new Date(START - 86_400_000))),
      artistId: () => 1,
      related: (id) => {
        if (id === 1) {
          return [
            { id: 10, name: 'First Ring A' },
            { id: 11, name: 'First Ring B' },
          ];
        }
        if (id === 10 || id === 11) {
          return [0, 1, 2, 3].map((n) => ({
            id: 700 + (id - 10) * 10 + n,
            name: `Second Ring ${id}-${n}`,
          }));
        }
        return [1, 2].map((n) => ({ id: id * 10 + n, name: `Further ${id}-${n}` }));
      },
      topsFor: (artistId) => [
        { title: `Song ${artistId}`, artist: `Band ${artistId}`, durationSec: 180 },
      ],
      searchOne: async (query) => found(query),
    });
    const played = await radio.play(10);
    assert.equal(played.length, 10);
    assert.ok(played.every((song) => song.vibe?.includes('new find')));
    assert.ok(played.every((song) => !song.title.includes('pop song')));
    assert.ok(played.some((song) => /Song 7\d\d/.test(song.title)));
    assert.equal(new Set(played.map((song) => song.url)).size, played.length);
  });

  it('searches a find with no YouTube match at most once in a show', async () => {
    const queries: string[] = [];
    const radio = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      artistId: () => 1,
      related: (id) => {
        if (id !== 1) {
          return [1, 2].map((n) => ({ id: id * 10 + n, name: `Next ${id}-${n}` }));
        }
        return [
          { id: 50, name: 'Dead Artist' },
          ...Array.from({ length: 8 }, (_, i) => ({ id: 200 + i, name: `Live ${i}` })),
        ];
      },
      topsFor: (artistId) =>
        artistId === 50
          ? [{ title: 'Miss Me', artist: 'Dead Artist', durationSec: 180 }]
          : [{ title: `Cut ${artistId}`, artist: `Band ${artistId}`, durationSec: 180 }],
      searchOne: async (query) => {
        queries.push(query);
        if (query.includes('Miss Me')) return null;
        return found(query);
      },
    });
    const played = await radio.play(14);
    assert.equal(played.length, 14);
    assert.equal(queries.filter((query) => query.includes('Miss Me')).length, 1);
  });

  it('does not pick a find that already aired, by name or by url', async () => {
    const named = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      aired: async () => [
        {
          songKey: 'stranger|brand-new',
          url: 'https://youtu.be/brand-new-old',
          artist: 'Stranger',
          title: 'Brand New',
          playedAt: new Date(START - 86_400_000),
        },
      ],
      related: [{ id: 7, name: 'Stranger' }],
      tops: [{ title: 'Brand New', artist: 'Stranger', durationSec: 180 }],
      searchOne: async (query) => found(query),
    });
    const namedPlayed = await named.play(8);
    assert.ok(namedPlayed.length >= 4);
    assert.ok(namedPlayed.every((song) => !song.title.includes('Brand New')));
    assert.equal(named.calls.youtube, 0);

    const taken = 'https://youtu.be/already-aired';
    const queries: string[] = [];
    const byUrl = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      aired: async () => [
        {
          songKey: 'old|title',
          url: taken,
          artist: 'Old Name',
          title: 'Old Title',
          playedAt: new Date(START - 86_400_000),
        },
      ],
      artistId: () => 1,
      related: () => [
        { id: 8, name: 'New Artist' },
        { id: 9, name: 'Fresh Artist' },
      ],
      topsFor: (artistId) => [
        {
          title: artistId === 8 ? 'New Title' : `Fresh ${artistId}`,
          artist: artistId === 8 ? 'New Artist' : `Fresh Artist ${artistId}`,
          durationSec: 180,
        },
      ],
      searchOne: async (query) => {
        queries.push(query);
        if (query.includes('New Title')) return found(query, taken);
        return found(query);
      },
    });
    const urlPlayed = await byUrl.play(8);
    assert.ok(urlPlayed.every((song) => song.url !== taken));
    assert.ok(urlPlayed.some((song) => song.title.includes('Fresh 9')));
    assert.equal(queries.filter((query) => query.includes('New Title')).length, 1);
  });

  it('fetches each artist’s related and top lists once per show', async () => {
    const relatedCalls = new Map<number, number>();
    const topCalls = new Map<number, number>();
    const radio = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('pop', n)),
      artistId: (key) => 1000 + Number(key.split('|')[1]),
      related: (id) => {
        relatedCalls.set(id, (relatedCalls.get(id) ?? 0) + 1);
        return [{ id: id + 100, name: `R${id}` }];
      },
      topsFor: (artistId) => {
        topCalls.set(artistId, (topCalls.get(artistId) ?? 0) + 1);
        return [{ title: `T${artistId}`, artist: `A${artistId}`, durationSec: 180 }];
      },
      searchOne: async (query) => found(query),
    });
    const played = await radio.play(14);
    assert.equal(played.length, 14);
    assert.ok(relatedCalls.size > 0);
    assert.ok(topCalls.size > 0);
    assert.ok([...relatedCalls.values()].every((count) => count === 1));
    assert.ok([...topCalls.values()].every((count) => count === 1));
  });

  it('plays the song that aired longest ago when nothing new is left, and warns', async () => {
    const pool = [1, 2, 3, 4, 5].map((n) => kitchenSong('pop', n));
    const warns: string[] = [];
    const radio = show({
      pool,
      blocks: false,
      warns,
      aired: async () => pool.map((song, n) => airedOf(song, new Date(START - (n + 1) * 1000))),
      related: [],
      tops: [],
      searchOne: async () => null,
    });
    const played = await radio.play(5);
    assert.equal(played.length, 5);
    assert.match(played[0]?.title ?? '', /pop song 5/);
    assert.match(played[1]?.title ?? '', /pop song 4/);
    assert.match(played[2]?.title ?? '', /pop song 3/);
    assert.ok(warns.some((line) => line.includes('nothing new could be found')));
    assert.ok(played.every((song) => song.vibe === 'kitchen throwbacks'));
  });
});
