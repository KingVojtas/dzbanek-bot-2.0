import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import type { DeezerTop, FmCatalog } from '../src/fm/catalog';
import { silenceMs } from '../src/fm/dedications';
import { FmStation } from '../src/fm/FmStation';
import {
  JINGLE_GAP_MS,
  JingleLibrary,
  classifyJingleName,
  namedJingle,
  type JingleFile,
} from '../src/fm/jingles';
import type { GenreId, GenreIndex } from '../src/fm/genres';
import type { RotationCursor } from '../src/fm/rotation';
import type { DjVoice } from '../src/fm/voice';
import { LINE_MOMENTS, LineBook, type LineFile, type Moment } from '../src/fm/lines';
import { OPENER_MAX_AGE_MS, type PreparedOpener } from '../src/fm/opener';
import { reactionSongKey, tallyReactions, toggleReaction } from '../src/fm/reactions';
import { sidelined, type FmSong } from '../src/fm/script';
import { songFromCatch, songFromTrack } from '../src/quiz/songs';
import type { AiredSong } from '../src/quiz/stores';

const START = Date.parse('2026-10-26T17:00:00Z');
const VOICE = 'en-US-AndrewMultilingualNeural';
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

/** A prepared opener for `song`, valid at `START` unless `over` says otherwise. */
function preparedFor(song: FmSong, over: Partial<PreparedOpener> = {}): PreparedOpener {
  return {
    track: asTrack(song),
    artist: song.artist,
    title: song.title,
    how: 'play',
    by: 'Vojta',
    key: song.key,
    genre: 'cz-rap',
    after: null,
    line: `Welcome in, Kitchen. First up, ${song.title} by ${song.artist}.`,
    pcm: Buffer.from('clip'),
    preparedAt: START,
    language: 'en',
    voice: VOICE,
    ...over,
  };
}

/** A line book with only the showOpen lines under test. */
function showOpenBook(showOpen: string[]): LineBook {
  const lines = {} as LineFile['lines'];
  for (const moment of Object.keys(LINE_MOMENTS) as Moment[]) lines[moment] = [];
  lines.showOpen = showOpen;
  return new LineBook({ version: 1, lines });
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
  /** Lines `logger.info` was given. */
  infos?: string[];
  /** Missed find queries, shared by every show built with this array. */
  deadFinds?: { artist: string; title: string }[];
  /** Playlist tracks for a rotation genre. Omitted means the station has none. */
  genreList?: (genre: GenreId) => Promise<DeezerTop[]>;
  /** Genre the previous show on this server ended on. */
  rotationCursor?: RotationCursor;
  /** Station songs per rotation block. Omitted uses the default, 15. */
  blockSongs?: number;
  /** Break between blocks, in seconds. Omitted uses the default, 180. */
  breakSeconds?: number;
  /** Station IDs and promos. Omitted means those parts are left out. */
  jingle?: DjVoice;
  /** Sung jingles. Omitted means the show has none. */
  jingles?: JingleLibrary | null;
  /** Clock start. The default is 18:00 in Prague on 2026-10-26. */
  start?: number;
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
  language?: 'en' | 'cs';
  voiceName?: string;
  prepared?: PreparedOpener | null;
  onConsume?: () => void;
  /** Undefined keeps the built-in template, so older tests do not load the line book. */
  lines?: LineBook | null;
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
    genreTracks: async () => [],
    artistCountry: async () => {
      calls.deezer += 1;
      return { ok: true, value: { country: null, tags: [] } };
    },
    lookupArea: async () => {
      calls.deezer += 1;
      return { ok: true, value: { country: null, parents: [] } };
    },
  };
  const clock = { now: opts.start ?? START };
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
      language: opts.language ?? 'en',
      voiceName: opts.voiceName ?? VOICE,
      discover: 2,
      blockSets: opts.blockSets ?? 2,
      blockSongs: opts.blockSongs,
      breakSeconds: opts.breakSeconds,
      jingle: opts.jingle,
      jingles: opts.jingles,
      genres,
      catalog,
      findBlocks: opts.findBlocks,
      aired: opts.aired,
      deadFinds: opts.deadFinds,
      rotationCursor: opts.rotationCursor,
      genreTracks: opts.genreList,
      lines: opts.lines === undefined ? null : opts.lines,
      prepared: opts.prepared,
      consumeOpener: opts.onConsume,
      now: () => clock.now,
      timezone: 'Europe/Prague',
      logger: {
        debug() {},
        info(...args: unknown[]) {
          opts.infos?.push(args.map((part) => String(part)).join(' '));
        },
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
    setClock(value: number) {
      clock.now = value;
    },
    /** Play `count` songs; stops early when the station has nothing. */
    async play(count: number): Promise<{ title: string; url: string; vibe: string | null }[]> {
      const played: { title: string; url: string; vibe: string | null }[] = [];
      for (let i = 0; i < count; i += 1) {
        const track = await station.upNext();
        if (!track) break;
        station.starting(track);
        played.push({ title: track.title, url: track.url, vibe: station.vibeOf(track) });
        clock.now += SONG_MS;
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

  it("plays a pop block from the kitchen's own pop before it looks for finds", async () => {
    // Twelve pop songs: rock, rap, EDM and Czech rap have nothing, so the
    // rotation lands on pop. Its first two sets are the kitchen's own songs,
    // so neither YouTube nor Deezer is asked for a find yet.
    const radio = show({
      pool: Array.from({ length: 12 }, (_, n) => kitchenSong('pop', n)),
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
    assert.match(first.title, /pop/);
    assert.equal(first.vibe, 'pop');
    assert.equal(radio.calls.youtube, 0);
  });

  it('plays a rotation block of indie, then moves on to Latin', async () => {
    const radio = show({
      pool: [
        ...Array.from({ length: 12 }, (_, n) => kitchenSong('indie', n)),
        ...Array.from({ length: 12 }, (_, n) => kitchenSong('latin', n)),
      ],
      blockSongs: 15,
      searchOne: async () => null,
    });
    const played = await radio.play(15);
    const vibe = played.map((song) => song.vibe?.replace(/ · new find$/, '') ?? '');
    assert.deepEqual(vibe.slice(0, 12), Array(12).fill('indie'));
    assert.deepEqual(vibe.slice(12, 15), Array(3).fill('Latin'));
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
      pool: [1, 2, 3, 4].map((n) => kitchenSong('rock', n)),
      artistId: () => undefined,
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

/** PCM the tests hand back instead of a Suno file. No FFmpeg. */
function tone(seconds: number, sample: number): Buffer {
  const frames = Math.round(seconds * 48_000);
  const out = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    out.writeInt16LE(sample, i * 4);
    out.writeInt16LE(sample, i * 4 + 2);
  }
  return out;
}

/** A library whose files are already PCM. `fail` makes those names throw. */
function memJingles(
  rows: { name: string; pcm: Buffer | null }[],
  fail: ReadonlySet<string> = new Set(),
): { lib: JingleLibrary; calls: string[] } {
  const files: JingleFile[] = [];
  const pcm = new Map<string, Buffer | null>();
  for (const row of rows) {
    const classified = classifyJingleName(row.name);
    if (!classified) continue;
    const path = `mem://${row.name}`;
    files.push({ ...classified, file: path });
    pcm.set(path, row.pcm);
  }
  const calls: string[] = [];
  const lib = new JingleLibrary({
    list: () => files,
    decode: async (file) => {
      calls.push(file);
      if (fail.has(file)) throw new Error('broken');
      const clip = pcm.get(file);
      if (!clip?.length) throw new Error('missing');
      return clip;
    },
  });
  return { lib, calls };
}

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

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('timed out');
}

describe('FmStation opener', () => {
  it('goes on air at the first song and keeps the rest of that set in order', async () => {
    const pool = [1, 2, 3, 4, 5, 6].map((n) => kitchenSong('cz-rap', n));
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: { query: string; release: () => void }[] = [];
    const infos: string[] = [];
    const radio = show({
      pool,
      infos,
      aired: async () => pool.map((song) => airedOf(song, new Date(START - 86_400_000))),
      artistId: (key) => 100 + Number(key.split('|')[1]),
      related: (seedId) => [{ id: seedId + 40, name: `Rel ${seedId}` }],
      topsFor: (artistId) => [
        { title: `Find ${artistId}`, artist: `Band ${artistId}`, durationSec: 180 },
      ],
      searchOne: (query) =>
        new Promise((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push({
            query,
            release: () => {
              inFlight -= 1;
              resolve(found(query));
            },
          });
        }),
    });

    const opening = radio.station.upNext();
    await until(() => pending.length >= 3);
    assert.equal(maxInFlight <= 3, true);
    const released: string[] = [];
    let settled = false;
    void opening.then(() => {
      settled = true;
    });
    const releaseNext = async (): Promise<void> => {
      await until(() => pending.length > released.length);
      const item = pending[released.length]!;
      released.push(item.query);
      item.release();
      await new Promise((resolve) => setImmediate(resolve));
    };
    // Four finds are not a set. The first song waits until five will play.
    for (let n = 0; n < 4; n += 1) await releaseNext();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    for (let n = 0; n < 12 && !settled; n += 1) await releaseNext();
    const first = await opening;
    assert.ok(first);
    assert.equal(first.url, found(released[0]!).url);
    assert.equal(radio.station.queued()?.url, first.url);
    const played = [first.url];
    radio.station.starting(first);
    for (let i = 0; i < 4; i += 1) {
      const track = await radio.station.upNext();
      assert.ok(track);
      assert.equal(played.includes(track.url), false);
      played.push(track.url);
      radio.station.starting(track);
    }
    assert.equal(played.length, 5);
    assert.equal(new Set(played).size, 5);
    assert.deepEqual(
      played,
      released.slice(0, 5).map((query) => found(query).url),
    );
    assert.equal(
      infos.some((line) => line.includes('set 2')),
      false,
    );
    assert.equal(maxInFlight <= 3, true);
  });

  it('does not search a missed find again in the next show', async () => {
    const pool = [1, 2, 3, 4].map((n) => kitchenSong('pop', n));
    const dead: { artist: string; title: string }[] = [];
    const shared = {
      pool,
      deadFinds: dead,
      aired: async () => pool.map((song) => airedOf(song, new Date(START - 86_400_000))),
      related: [{ id: 7, name: 'Stranger' }],
      tops: [{ title: 'Brand New', artist: 'Stranger', durationSec: 180 }],
      searchOne: async () => null,
    };
    const first = show(shared);
    const opened = await first.play(1);
    assert.equal(opened.length, 1);
    assert.equal(first.calls.youtube, 1);
    assert.deepEqual(dead, [{ artist: 'Stranger', title: 'Brand New' }]);
    first.station.end();

    const second = show(shared);
    const again = await second.play(1);
    assert.equal(again.length, 1);
    assert.equal(second.calls.youtube, 0);
  });

  it('keeps at most 3 YouTube searches in flight and stops at the cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pool = [1, 2, 3, 4, 5, 6].map((n) => kitchenSong('pop', n));
    const radio = show({
      pool,
      aired: async () => pool.map((song) => airedOf(song, new Date(START - 86_400_000))),
      artistId: (key) => 100 + Number(key.split('|')[1]),
      related: (id) => [0, 1, 2, 3].map((n) => ({ id: id * 10 + n, name: `R${id}-${n}` })),
      topsFor: (artistId) => [{ title: `T${artistId}`, artist: `A${artistId}`, durationSec: 180 }],
      searchOne: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          setImmediate(() => {
            inFlight -= 1;
            resolve(null);
          });
        });
      },
    });
    const played = await radio.play(1);
    assert.equal(played.length, 1);
    assert.equal(maxInFlight <= 3, true);
    assert.equal(maxInFlight > 1, true);
    // Each pass stops at its cap of 10: the pop rotation block, then the finds
    // fallback once the rotation has nothing playable.
    assert.equal(radio.calls.youtube, 20);
  });
});

describe('FmStation genre rotation', () => {
  const rotationPool = [
    ...Array.from({ length: 20 }, (_, n) => kitchenSong('rock', n)),
    ...Array.from({ length: 20 }, (_, n) => kitchenSong('rap', n)),
  ];

  it('plays 15 rock songs, then rap, and trims the last set of a shorter block', async () => {
    const infos: string[] = [];
    const radio = show({
      pool: rotationPool,
      infos,
      blockSongs: 12,
      breakSeconds: 0,
      searchOne: async () => null,
    });
    const played = await radio.play(13);
    const vibe = played.map((song) => song.vibe ?? '');
    assert.deepEqual(vibe.slice(0, 12), Array(12).fill('rock'));
    assert.equal(vibe[12], 'rap');
    assert.ok(infos.some((line) => line.includes('rock for 12 songs (next: rap).')));
  });

  it('does not count a request toward the 15', async () => {
    const radio = show({
      pool: rotationPool,
      blockSongs: 15,
      breakSeconds: 0,
      searchOne: async () => null,
    });
    const first = await radio.play(10);
    radio.station.heard({
      title: 'A request',
      url: 'https://youtu.be/request',
      durationSec: 180,
      requestedBy: 'Vojta',
    });
    const rest = await radio.play(6);
    const played = [...first, ...rest];
    assert.deepEqual(
      played.slice(0, 15).map((song) => song.vibe),
      Array(15).fill('rock'),
    );
    assert.equal(played[15]?.vibe, 'rap');
  });

  it('starts the next show at the genre after the one this show ended on', async () => {
    const cursor: RotationCursor = { genre: null };
    const first = show({
      pool: rotationPool,
      rotationCursor: cursor,
      breakSeconds: 0,
      searchOne: async () => null,
    });
    const played = await first.play(5);
    assert.ok(played.every((song) => song.vibe === 'rock'));
    first.station.end();
    assert.equal(cursor.genre, 'rock');

    const second = show({
      pool: rotationPool,
      rotationCursor: cursor,
      breakSeconds: 0,
      searchOne: async () => null,
    });
    const again = await second.play(5);
    assert.ok(again.every((song) => song.vibe === 'rap'));
    const urls = new Set(played.map((song) => song.url));
    assert.ok(again.every((song) => !urls.has(song.url)));
  });

  it('skips an empty genre and does not replay a song that already aired', async () => {
    const infos: string[] = [];
    const edm = Array.from({ length: 12 }, (_, n) => kitchenSong('edm', n));
    const aired = edm.slice(0, 2);
    const radio = show({
      pool: edm,
      infos,
      breakSeconds: 0,
      aired: async () => aired.map((song) => airedOf(song, new Date(START - 86_400_000))),
      searchOne: async () => null,
    });
    const played = await radio.play(5);
    assert.ok(played.every((song) => song.vibe === 'EDM'));
    const urls = played.map((song) => song.url);
    assert.equal(urls.includes(aired[0]!.url!), false);
    assert.equal(urls.includes(aired[1]!.url!), false);
    assert.ok(infos.some((line) => line.includes('no playable songs for rock')));
    assert.ok(infos.some((line) => line.includes('no playable songs for rap')));
  });

  it('skips "a bit of everything" until five unaired songs are waiting', async () => {
    const infos: string[] = [];
    const short = show({
      pool: [1, 2, 3, 4].map((n) => kitchenSong('other', n)),
      infos,
      breakSeconds: 0,
      searchOne: async () => null,
    });
    await short.play(4);
    // The fallback's mixed theme shares the name, so check that no rotation block started.
    assert.ok(!infos.some((line) => line.includes('a bit of everything for 15 songs')));
    assert.ok(infos.some((line) => line.includes('no playable songs for a bit of everything')));

    const ready = show({
      pool: [1, 2, 3, 4, 5].map((n) => kitchenSong('other', n)),
      breakSeconds: 0,
      artistId: () => undefined,
      searchOne: async () => {
        throw new Error('other has no finds');
      },
    });
    const songs = await ready.play(5);
    assert.ok(songs.every((song) => song.vibe === 'a bit of everything'));
    assert.equal(ready.calls.deezer, 0);
    assert.equal(ready.calls.youtube, 0);
  });

  it('plays a playlist for the first genre when the kitchen has never played it', async () => {
    const queries: string[] = [];
    const radio = show({
      pool: [1, 2, 3, 4, 5, 6].map((n) => kitchenSong('pop', n)),
      artistId: () => undefined,
      breakSeconds: 0,
      aired: async () => [
        {
          songKey: 'stranger|old-hit',
          url: 'https://youtu.be/old-hit',
          artist: 'Stranger',
          title: 'Old Hit',
          playedAt: new Date(START - 86_400_000),
        },
      ],
      genreList: async (genre) =>
        genre === 'rock'
          ? [
              { title: 'Old Hit', artist: 'Stranger', durationSec: 180 },
              { title: 'Fresh Cut', artist: 'Outside', durationSec: 200 },
              { title: 'Second Cut', artist: 'Outside', durationSec: 190 },
              { title: 'Third Cut', artist: 'Outside', durationSec: 188 },
              { title: 'Fourth Cut', artist: 'Outside', durationSec: 176 },
              { title: 'Fifth Cut', artist: 'Outside', durationSec: 210 },
            ]
          : [],
      searchOne: async (query) => {
        queries.push(query);
        return found(query);
      },
    });
    const played = await radio.play(1);
    assert.equal(played.length, 1);
    assert.equal(played[0]?.title.includes('Old Hit'), false);
    assert.match(played[0]?.vibe ?? '', /rock/);
    assert.match(played[0]?.vibe ?? '', /new find/);
    assert.equal(
      queries.some((query) => query.includes('Old Hit')),
      false,
    );
  });

  it('plays the new-find jingle once per block, not on a block’s first set', async () => {
    const { lib } = memJingles([{ name: 'new-find.mp3', pcm: tone(0.25, 4_000) }]);
    const speaks: string[] = [];
    const infos: string[] = [];
    const cuts = (artist: string, title: string, count: number) =>
      Array.from({ length: count }, (_, n) => ({
        title: `${title} ${n + 1}`,
        artist,
        durationSec: 200,
      }));
    const radio = show({
      pool: [1, 2, 3, 4, 5, 6].map((n) => kitchenSong('pop', n)),
      artistId: () => undefined,
      breakSeconds: 0,
      blockSongs: 15,
      jingles: lib,
      infos,
      genreList: async (genre) => {
        if (genre === 'rock') return cuts('Outside', 'Fresh Cut', 15);
        if (genre === 'rap') return cuts('Rapper', 'Street Cut', 5);
        return [];
      },
      searchOne: async (query) => found(query),
      speak: async (text) => {
        speaks.push(text);
        return Buffer.from('line');
      },
    });
    const sets: { vibe: string; pcm: Buffer | null; text: string }[] = [];
    for (let i = 0; i < 16; i += 1) {
      const track = await radio.station.upNext();
      assert.ok(track, infos.join('\n'));
      const intro = await radio.station.intro(track);
      if (intro) {
        sets.push({
          vibe: radio.station.vibeOf(track) ?? '',
          pcm: intro.pcm,
          text: intro.text,
        });
      }
      radio.station.starting(track);
      radio.setClock(START + (i + 1) * SONG_MS);
    }
    assert.equal(sets.length, 4, `${sets.map((set) => set.vibe).join(' | ')}\n${infos.join('\n')}`);
    const lead = await lib.clip(namedJingle(lib.files(), 'new-find'));
    assert.ok(lead);
    const line = Buffer.from('line');
    const withJingle = lead.length + silenceMs(JINGLE_GAP_MS).length + line.length;
    const clips = sets.map((set) => set.pcm);
    assert.deepEqual(
      sets.map((set) => set.vibe),
      ['rock · new find', 'rock · new find', 'rock · new find', 'rap · new find'],
    );
    assert.equal(clips[0]?.equals(line), true);
    const sung = clips[1];
    assert.ok(sung);
    assert.equal(sung.length, withJingle);
    assert.equal(sung.subarray(0, lead.length).equals(lead), true);
    assert.equal(sung.subarray(sung.length - line.length).equals(line), true);
    assert.equal(clips[2]?.equals(line), true);
    assert.equal(clips[3]?.equals(line), true);
    assert.deepEqual(
      sets.map((set) => set.text),
      speaks,
    );
    assert.equal(speaks.length, 4);
  });

  it('plays the break before the next block, and skips it when breakSeconds is 0', async () => {
    const pcm = (seconds: number) => Buffer.alloc(Math.round(seconds * 48_000 * 2 * 2));
    const spoken: string[] = [];
    const voice = {
      speak: async (text: string) => {
        spoken.push(text);
        return pcm(1);
      },
    };
    const radio = show({
      pool: rotationPool,
      blockSongs: 5,
      breakSeconds: 8,
      speak: voice.speak,
      jingle: voice as DjVoice,
      searchOne: async () => null,
    });
    await radio.play(5);
    const next = await radio.station.upNext();
    assert.ok(next);
    const intro = await radio.station.intro(next);
    assert.match(intro?.text ?? '', /^📻 Kitchen FM break · next up: rap$/);
    assert.ok((intro?.pcm?.length ?? 0) > pcm(1).length);
    assert.equal(intro?.text.includes('{'), false);

    const quiet = show({
      pool: rotationPool,
      blockSongs: 5,
      breakSeconds: 0,
      lines: null,
      searchOne: async () => null,
    });
    await quiet.play(5);
    const plain = await quiet.station.upNext();
    assert.ok(plain);
    const line = await quiet.station.intro(plain);
    assert.equal((line?.text ?? '').includes('Kitchen FM break'), false);
  });
});

describe('FmStation prepared opener', () => {
  const pool = () => [0, 1, 2, 3, 4, 5].map((n) => kitchenSong('cz-rap', n));

  it('opens with the prepared song and fills the rest of set 1 without searching or speaking', async () => {
    const songs = pool();
    const opener = preparedFor(songs[0]!);
    const infos: string[] = [];
    const speaks: string[] = [];
    let consumed = 0;
    const radio = show({
      pool: songs,
      prepared: opener,
      onConsume: () => {
        consumed += 1;
      },
      infos,
      speak: async (text) => {
        speaks.push(text);
        return Buffer.from('live');
      },
      searchOne: async () => {
        throw new Error('YouTube should not be asked');
      },
    });
    const played = await radio.play(5);
    assert.equal(played.length, 5);
    assert.equal(played[0]?.url, opener.track.url);
    assert.equal(new Set(played.map((song) => song.url)).size, 5);
    assert.ok(played.every((song) => songs.some((item) => item.url === song.url)));
    assert.equal(radio.calls.youtube, 0);
    assert.deepEqual(speaks, []);
    assert.equal(consumed, 1);
    assert.ok(
      infos.includes(
        'Kitchen FM in Kitchen: using the prepared opener "cz-rap artist 0 - cz-rap song 0" (Czech rap).',
      ),
    );
    const intro = await radio.station.intro(opener.track);
    assert.equal(intro?.text, opener.line);
    assert.equal(intro?.pcm, opener.pcm);
    assert.deepEqual(speaks, []);
  });

  it('puts the prepared song on air at once, even when its genre still needs finds', async () => {
    // The live start of 30 Oct 2026 waited 8 s: one kitchen song, so the station
    // proved the genre with five finds before it used the opener it already had.
    const songs = [kitchenSong('cz-rap', 0)];
    const opener = preparedFor(songs[0]!);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const radio = show({
      pool: songs,
      prepared: opener,
      genreList: async () =>
        [1, 2, 3, 4, 5].map((n) => ({ title: `Far ${n}`, artist: `Away ${n}`, durationSec: 200 })),
      searchOne: async () => {
        await gate;
        return null;
      },
    });
    const first = await Promise.race([
      radio.station.upNext(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    assert.equal(first?.url, opener.track.url);
    release();
    radio.station.end();
  });

  it('opens with the line alone, no jingle in front, so the first song comes sooner', async () => {
    const songs = pool();
    const opener = preparedFor(songs[0]!);
    const { lib, calls } = memJingles([
      { name: 'id-main.mp3', pcm: tone(0.2, 8_000) },
      { name: 'id-jazz.mp3', pcm: tone(0.2, 1_000) },
    ]);
    const radio = show({
      pool: songs,
      prepared: opener,
      jingles: lib,
      searchOne: async () => {
        throw new Error('YouTube should not be asked');
      },
    });
    await radio.play(1);
    const intro = await radio.station.intro(opener.track);
    assert.equal(intro?.text, opener.line);
    assert.equal(intro?.pcm, opener.pcm);
    assert.deepEqual(calls, []);
  });

  it("hands the prepared song's downloaded audio to the player once", async () => {
    const songs = pool();
    const audio = Buffer.from('whole song');
    const opener = preparedFor(songs[0]!, { audio });
    const radio = show({
      pool: songs,
      prepared: opener,
      searchOne: async () => {
        throw new Error('YouTube should not be asked');
      },
    });
    const first = await radio.station.upNext();
    assert.equal(first?.url, opener.track.url);
    assert.equal(radio.station.preloadedAudio(asTrack(songs[1]!)), null);
    assert.equal(radio.station.preloadedAudio(first!), audio);
    assert.equal(radio.station.preloadedAudio(first!), null);
  });

  it('uses the prepared song and synthesizes the line when the clip is missing', async () => {
    const songs = pool();
    const opener = preparedFor(songs[0]!, { pcm: null });
    const speaks: string[] = [];
    const radio = show({
      pool: songs,
      prepared: opener,
      speak: async (text) => {
        speaks.push(text);
        return Buffer.from('live');
      },
      searchOne: async () => {
        throw new Error('YouTube should not be asked');
      },
    });
    const played = await radio.play(1);
    assert.equal(played[0]?.url, opener.track.url);
    assert.equal(radio.calls.youtube, 0);
    assert.deepEqual(speaks, [opener.line]);
    const intro = await radio.station.intro(opener.track);
    assert.equal(intro?.text, opener.line);
    assert.equal(speaks.length, 1);
  });

  async function fallsBack(
    reason: string,
    opts: {
      over?: Partial<PreparedOpener>;
      song?: FmSong;
      /** Kitchen the show reads. Defaults to six unaired Czech rap songs. */
      pool?: FmSong[];
      aired?: () => Promise<readonly AiredSong[]>;
      findBlocks?: () => Promise<readonly { artist: string; title: string }[]>;
      heard?: boolean;
    } = {},
  ): Promise<void> {
    const songs = opts.pool ?? pool();
    const chosen = opts.song ?? kitchenSong('cz-rap', 99);
    const opener = preparedFor(chosen, opts.over);
    const infos: string[] = [];
    const speaks: string[] = [];
    let consumed = 0;
    const radio = show({
      pool: songs,
      prepared: opener,
      onConsume: () => {
        consumed += 1;
      },
      infos,
      aired: opts.aired,
      findBlocks: opts.findBlocks,
      speak: async (text) => {
        speaks.push(text);
        return Buffer.from('live');
      },
    });
    if (opts.heard) radio.station.heard(opener.track);
    const played = await radio.play(1);
    assert.equal(played.length, 1);
    assert.notEqual(played[0]?.url, chosen.url);
    assert.equal(speaks.length, 1);
    assert.equal(consumed, 1);
    assert.ok(
      infos.includes(`Kitchen FM in Kitchen: dropping the prepared opener, ${reason}.`),
      infos.join('\n'),
    );
  }

  it('drops an opener prepared for a different point in the rotation', async () => {
    await fallsBack('the rotation moved on', { over: { after: 'rock' } });
  });

  it('drops an opener older than 12 hours', async () => {
    await fallsBack('it is older than 12 hours', {
      over: { preparedAt: START - OPENER_MAX_AGE_MS },
    });
  });

  it('drops an opener that has aired since it was prepared', async () => {
    const chosen = kitchenSong('cz-rap', 99);
    await fallsBack('it has aired since it was prepared', {
      song: chosen,
      aired: async () => [
        {
          songKey: chosen.key,
          url: chosen.url ?? '',
          artist: chosen.artist,
          title: chosen.title,
          playedAt: new Date(START),
        },
      ],
    });
  });

  it('drops an opener someone put on after it was prepared', async () => {
    await fallsBack('it has aired since it was prepared', { heard: true });
  });

  it('drops an opener the kitchen has thumbs-downed', async () => {
    const chosen = { ...kitchenSong('cz-rap', 0), nopes: 2 };
    await fallsBack('it is blocked', {
      song: chosen,
      pool: [chosen, ...[1, 2, 3, 4, 5].map((n) => kitchenSong('cz-rap', n))],
    });
  });

  it('drops a prepared find a thumbs-down has blocked', async () => {
    const chosen = kitchenSong('cz-rap', 99);
    await fallsBack('it is blocked', {
      song: chosen,
      findBlocks: async () => [{ artist: chosen.artist, title: chosen.title }],
    });
  });

  it('drops an opener made in another language', async () => {
    await fallsBack('it was made in another language', { over: { language: 'cs' } });
  });

  it('drops an opener made with another voice', async () => {
    await fallsBack('the DJ voice changed', { over: { voice: 'cs-CZ-VlastaNeural' } });
  });

  it('prepares a showOpen line with no clock in it, and does not speak', async () => {
    const speaks: string[] = [];
    const radio = show({
      pool: pool(),
      lines: showOpenBook([
        'It is {time}, good {daypart}, {song}.',
        'Welcome in, {server}. {genre} starts with {song}.',
      ]),
      speak: async (text) => {
        speaks.push(text);
        return Buffer.from('live');
      },
      searchOne: async () => {
        throw new Error('YouTube should not be asked');
      },
    });
    const found = await radio.station.prepareOpener();
    assert.ok(found);
    assert.match(found.line, /^Welcome in, Kitchen\. Czech rap starts with /);
    assert.equal(found.line.includes('12 AM'), false);
    assert.equal(found.line.includes('late night'), false);
    assert.equal(/\{(time|daypart)\}/.test(found.line), false);
    assert.deepEqual(speaks, []);
    assert.equal(radio.calls.youtube, 0);
  });

  it('uses the built-in greeting when every showOpen line names the time', async () => {
    const radio = show({
      pool: pool(),
      lines: showOpenBook(['It is {time}, good {daypart}, {song}.']),
    });
    const found = await radio.station.prepareOpener();
    assert.ok(found);
    assert.equal(
      found.line,
      `Kitchen, this is Kitchen FM. We're going for Czech rap. First up, ${found.title} by ${found.artist}.`,
    );
    assert.equal(found.line.includes('12 AM'), false);
    assert.equal(found.line.includes('late night'), false);
  });
});
