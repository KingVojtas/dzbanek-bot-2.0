import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoiceBasedChannel } from 'discord.js';
import type { Config } from '../src/config';
import type { Logger } from '../src/core/logger';
import type { Track } from '../src/core/types';
import type { FmCatalog } from '../src/fm/catalog';
import { KitchenFm } from '../src/fm/KitchenFm';
import { JingleLibrary, type JingleFile } from '../src/fm/jingles';
import type { GenreId, GenreIndex } from '../src/fm/genres';
import type { LineSlots } from '../src/fm/lines';
import {
  OPENER_MAX_AGE_MS,
  openerDropReason,
  openerIsBlocked,
  preparedShowLine,
  timelessLines,
  timelessOpener,
  type OpenerCheck,
  type PreparedOpener,
} from '../src/fm/opener';
import type { DjVoice } from '../src/fm/voice';
import type { MusicManager } from '../src/music/MusicManager';
import type { RadioCatchStore } from '../src/kitchen/catches';
import type { SongReactionStore } from '../src/fm/reactions';
import type { PlayLogStore, PlayedTrackRow, PlayedTrackStore } from '../src/quiz/stores';

const START = Date.parse('2026-10-26T17:00:00Z');
const VOICE = 'en-US-AndrewMultilingualNeural';

function opener(over: Partial<PreparedOpener> = {}): PreparedOpener {
  const track: Track = {
    title: 'A - B',
    url: 'https://youtu.be/a',
    durationSec: 200,
    requestedBy: 'Vojta',
  };
  return {
    track,
    artist: 'A',
    title: 'B',
    how: 'play',
    by: null,
    key: 'a|b',
    genre: 'cz-rap',
    after: null,
    line: 'Welcome in, Kitchen.',
    pcm: null,
    preparedAt: 1_000,
    language: 'en',
    voice: 'voice',
    ...over,
  };
}

function check(over: Partial<OpenerCheck> = {}): OpenerCheck {
  return {
    now: 1_000,
    language: 'en',
    voice: 'voice',
    airedKeys: new Set(),
    airedUrls: new Set(),
    plannedKeys: new Set(),
    plannedUrls: new Set(),
    after: null,
    blocked: false,
    ...over,
  };
}

const slots: LineSlots = {
  server: 'Kitchen',
  time: '6 PM',
  daypart: 'evening',
  genre: 'Czech rap',
  song: 'Numb by Linkin Park',
  artist: 'Linkin Park',
  by: '',
  names: '',
  station: 'Kitchen FM',
  from: '',
  to: '',
  message: '',
};

describe('prepared opener rules', () => {
  it('keeps an opener prepared for the genre the next show would open with', () => {
    assert.equal(openerDropReason(opener(), check()), null);
    assert.equal(
      openerDropReason(opener({ preparedAt: 0 }), check({ now: OPENER_MAX_AGE_MS - 1 })),
      null,
    );
  });

  it('names why an opener can no longer open the show', () => {
    assert.equal(openerDropReason(opener({ after: 'rock' }), check()), 'the rotation moved on');
    assert.equal(openerDropReason(opener(), check({ after: 'cz-rap' })), 'the rotation moved on');
    assert.equal(
      openerDropReason(opener({ preparedAt: 0 }), check({ now: OPENER_MAX_AGE_MS })),
      'it is older than 12 hours',
    );
    assert.equal(
      openerDropReason(opener({ language: 'cs' }), check()),
      'it was made in another language',
    );
    assert.equal(openerDropReason(opener({ voice: 'other' }), check()), 'the DJ voice changed');
    assert.equal(
      openerDropReason(opener(), check({ airedKeys: new Set(['a|b']) })),
      'it has aired since it was prepared',
    );
    assert.equal(
      openerDropReason(opener(), check({ plannedUrls: new Set(['https://youtu.be/a']) })),
      'it has aired since it was prepared',
    );
    assert.equal(openerDropReason(opener(), check({ blocked: true })), 'it is blocked');
  });

  it('treats a sidelined kitchen song and a blocked find as blocked', () => {
    const song = { key: 'a|b', artist: 'A', title: 'B' };
    assert.equal(openerIsBlocked(song, [{ key: 'a|b', nopes: 2, heat: 0 }], []), true);
    assert.equal(openerIsBlocked(song, [{ key: 'a|b', nopes: 1, heat: 5 }], []), false);
    assert.equal(openerIsBlocked(song, [], [{ artist: 'A', title: 'B' }]), true);
    assert.equal(openerIsBlocked(song, [], [{ artist: 'Other', title: 'Song' }]), false);
  });

  it('speaks only a showOpen line with no clock, or a built-in line', () => {
    assert.deepEqual(timelessLines(['It is {time}.', 'Good {daypart}.', 'Hello {server}.']), [
      'Hello {server}.',
    ]);
    assert.equal(
      preparedShowLine(['It is {time}.', 'Hello {server}, {song}.'], slots, () => 0),
      'Hello Kitchen, Numb by Linkin Park.',
    );
    assert.equal(
      preparedShowLine(['It is {time}, good {daypart}.'], slots, () => 0),
      null,
    );
    const fallback = timelessOpener({
      language: 'en',
      server: 'Kitchen',
      vibe: 'Czech rap',
      song: { artist: 'Linkin Park', title: 'Numb', by: null, how: 'play' },
    });
    assert.equal(
      fallback,
      "Kitchen, this is Kitchen FM. We're going for Czech rap. First up, Numb by Linkin Park.",
    );
    assert.equal(fallback.includes('6 PM'), false);
    assert.equal(fallback.includes('evening'), false);
    const czech = timelessOpener({
      language: 'cs',
      server: 'Kuchyně',
      vibe: 'český rap',
      song: { artist: 'Linkin Park', title: 'Numb', by: null, how: 'play' },
    });
    assert.equal(czech.includes('večer'), false);
    assert.equal(czech.includes('0:00'), false);
    assert.match(czech, /Numb – Linkin Park/);
  });
});

/** One server's kitchen, clock, and the counts a preparation must not touch. */
function harness(jingles: JingleLibrary | null = null) {
  const clock = { now: START };
  const infos: string[] = [];
  const warns: string[] = [];
  const speaks: string[] = [];
  const adds = { n: 0 };
  const searches = { n: 0 };
  const poolEntered = { n: 0 };
  const rows = new Map<string, PlayedTrackRow[]>();
  const flags = { holdPool: null as Promise<void> | null, holdSpeak: false };
  let releaseSpeak: (pcm: Buffer | null) => void = () => {};
  const players = new Map<
    string,
    { onAir: boolean; stop: () => void; setStation: (station: { end: () => void }) => void }
  >();

  const genres: GenreIndex = {
    genreOf: () => 'cz-rap' as GenreId,
    artistId: () => undefined,
    ready: () => true,
    enqueue() {},
  };
  const catalog = {
    searchTrack: async () => ({ ok: true as const, value: null }),
    albumGenres: async () => ({ ok: true as const, value: [] }),
    relatedArtists: async () => [],
    topTracks: async () => [],
    genreTracks: async () => [],
    artistCountry: async () => ({ ok: true as const, value: { country: null, tags: [] } }),
    lookupArea: async () => ({ ok: true as const, value: { country: null, parents: [] } }),
  } as FmCatalog;
  const voice = {
    speak: async (text: string) => {
      speaks.push(text);
      if (!flags.holdSpeak) return Buffer.alloc(48_000 * 2 * 2);
      return new Promise<Buffer | null>((resolve) => {
        releaseSpeak = resolve;
      });
    },
  } as unknown as DjVoice;
  const logger = {
    debug() {},
    info(message: string, ...args: unknown[]) {
      infos.push([message, ...args].map((part) => String(part)).join(' '));
    },
    warn(message: string, ...args: unknown[]) {
      warns.push([message, ...args].map((part) => String(part)).join(' '));
    },
    error() {},
  } as unknown as Logger;
  const music = {
    trackSource: {
      youtube: {
        searchOne: async () => {
          searches.n += 1;
          return null;
        },
      },
    },
    join: async (voiceChannel: { guild: { id: string } }) => {
      let station: { end: () => void } | null = null;
      const player = {
        onAir: true,
        setAnnounceChannel() {},
        setStation(next: { end: () => void }) {
          station = next;
        },
        stop() {
          player.onAir = false;
          station?.end();
        },
        connection: { joinConfig: { channelId: 'voice' } },
      };
      players.set(voiceChannel.guild.id, player);
      return player;
    },
    get: (guildId: string) => players.get(guildId) ?? null,
  } as unknown as MusicManager;
  const config = {
    timezone: 'Europe/Prague',
    dj: {
      language: 'en' as const,
      voice: VOICE,
      model: 'test',
      discover: 2,
      blockSets: 2,
      setsPerServerPerDay: 0,
      setsPerDay: 0,
    },
  } as Config;
  const fm = new KitchenFm(
    music,
    {
      all: async (guildId: string) => {
        poolEntered.n += 1;
        if (flags.holdPool) await flags.holdPool;
        return rows.get(guildId) ?? [];
      },
    } as unknown as PlayedTrackStore,
    { between: async () => [] } as unknown as RadioCatchStore,
    {
      tally: async () => ({ fires: new Map(), nopes: new Map(), blocked: [] }),
    } as unknown as SongReactionStore,
    {
      aired: async () => [],
      add: async () => {
        adds.n += 1;
      },
    } as unknown as PlayLogStore,
    config,
    logger,
    { now: () => clock.now, catalog, genres, voice, jingles },
  );

  return {
    fm,
    clock,
    infos,
    warns,
    speaks,
    adds,
    searches,
    poolEntered,
    setRows(id: string, count: number) {
      rows.set(
        id,
        Array.from({ length: count }, (_, i) => ({
          url: `https://youtu.be/${id}-${i}`,
          title: `Band ${id} ${i} - Song ${i}`,
          uploader: null,
          thumbnail: null,
          durationSec: 200,
          requestedById: null,
          playedAt: new Date(START - i * 1000),
        })),
      );
    },
    guild(id = 'g1', name = 'Kitchen') {
      return {
        id,
        name,
        members: { cache: new Map(), fetch: async () => null },
        channels: { cache: new Map() },
      };
    },
    holdPool() {
      let release: () => void = () => {};
      flags.holdPool = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release() {
          flags.holdPool = null;
          release();
        },
      };
    },
    holdSpeak() {
      flags.holdSpeak = true;
    },
    releaseSpeak(pcm: Buffer | null) {
      flags.holdSpeak = false;
      releaseSpeak(pcm);
    },
    async goOnAir(guild: { id: string; name: string }) {
      const channel = {
        id: 'voice',
        name: 'Speakers',
        guild,
      } as unknown as VoiceBasedChannel;
      return fm.start(channel, null);
    },
    close() {
      fm.stopBackgroundWork();
    },
  };
}

async function waitFor(ready: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('KitchenFm prepares the next opener', () => {
  it('stores a voiced opener and does not write the play log', async () => {
    const h = harness();
    h.setRows('g1', 5);
    await h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    const stored = h.fm.openerFor('g1');
    assert.ok(stored);
    assert.equal(stored.genre, 'cz-rap');
    assert.equal(stored.after, null);
    assert.equal(h.fm.openingGenre('g1'), 'rock');
    assert.equal(stored.language, 'en');
    assert.equal(stored.voice, VOICE);
    assert.equal(stored.pcm?.length, 48_000 * 2 * 2);
    assert.equal(/\{(time|daypart)\}/.test(stored.line), false);
    assert.equal(stored.line.includes('12 AM'), false);
    assert.equal(stored.line.includes('late night'), false);
    assert.equal(h.adds.n, 0);
    assert.equal(h.searches.n, 0);
    assert.ok(
      h.infos.some((line) =>
        /Kitchen FM in Kitchen: next opener ready: "Band g1 \d - Song \d" \(Czech rap\), clip 1\.0 s\./.test(
          line,
        ),
      ),
    );
  });

  it('logs a warning and stores nothing when no song will play', async () => {
    const h = harness();
    h.setRows('g1', 0);
    await h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    assert.equal(h.fm.openerFor('g1'), null);
    assert.ok(h.warns.some((line) => line.includes('could not prepare the next opener')));
    assert.equal(h.adds.n, 0);
    h.setRows('g1', 5);
    await h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    assert.ok(h.fm.openerFor('g1'));
  });

  it('keeps the previous opener when a later preparation fails', async () => {
    const h = harness();
    h.setRows('g1', 5);
    await h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    const kept = h.fm.openerFor('g1');
    assert.ok(kept);
    h.setRows('g1', 0);
    await h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    assert.equal(h.fm.openerFor('g1'), kept);
    assert.equal(h.adds.n, 0);
  });

  it('stores the spoken greeting without the station ID', async () => {
    const sung = Buffer.alloc(48_000 * 4);
    const file: JingleFile = { kind: 'id', id: 'main', file: 'mem://id-main.mp3' };
    const fm = harness(
      new JingleLibrary({
        list: () => [file],
        decode: async () => sung,
      }),
    );
    fm.setRows('g1', 5);
    await fm.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    const stored = fm.fm.openerFor('g1');
    assert.equal(stored?.pcm?.length, 48_000 * 2 * 2);
  });

  it('does not prepare while a show is on, and prepares again once it ends', async () => {
    const h = harness();
    try {
      const guild = h.guild();
      h.setRows(guild.id, 5);
      await h.goOnAir(guild);
      await h.fm.prepareNext(guild);
      await h.fm.prepareNext(guild);
      assert.equal(h.fm.openerFor(guild.id), null);
      assert.equal(h.speaks.length, 0);
      assert.equal(h.fm.stop(guild.id), true);
      await waitFor(() => h.fm.openerFor(guild.id) !== null);
      const stored = h.fm.openerFor(guild.id);
      assert.equal(stored?.genre, 'cz-rap');
      assert.equal(stored?.line.includes('12 AM'), false);
      assert.equal(stored?.line.includes('late night'), false);
      assert.equal(h.adds.n, 0);
      assert.ok(h.infos.some((line) => line.includes('next opener ready')));
    } finally {
      h.close();
    }
  });

  it('does not run a second preparation for one server until the first finishes', async () => {
    const h = harness();
    h.setRows('g1', 5);
    const held = h.holdPool();
    const first = h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    const second = h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    assert.equal(first, second);
    assert.equal(h.poolEntered.n, 1);
    held.release();
    await first;
    assert.equal(h.poolEntered.n, 1);
    assert.ok(h.fm.openerFor('g1'));
    assert.equal(h.adds.n, 0);
  });

  it('drops an in-flight opener when the show goes on before it is stored', async () => {
    const h = harness();
    try {
      const guild = h.guild();
      h.setRows(guild.id, 5);
      h.holdSpeak();
      const pending = h.fm.prepareNext(guild);
      await waitFor(() => h.speaks.length === 1);
      await h.goOnAir(guild);
      h.releaseSpeak(Buffer.alloc(4));
      await pending;
      assert.equal(h.fm.openerFor(guild.id), null);
      assert.equal(h.adds.n, 0);
    } finally {
      h.close();
    }
  });

  it('does not finish a preparation after background work has stopped', async () => {
    const h = harness();
    h.setRows('g1', 5);
    h.holdSpeak();
    const pending = h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
    await waitFor(() => h.speaks.length === 1);
    h.fm.stopBackgroundWork();
    h.releaseSpeak(Buffer.alloc(4));
    await pending;
    assert.equal(h.fm.openerFor('g1'), null);
  });

  it('prepares at most ten kitchens after boot, and skips a kitchen that is too small', async () => {
    const h = harness();
    try {
      h.setRows('small', 2);
      const guilds = [{ id: 'small', name: 'Small' }];
      for (let i = 0; i < 11; i += 1) {
        h.setRows(`e${i}`, 5);
        guilds.push({ id: `e${i}`, name: `Server ${i}` });
      }
      h.fm.startBackgroundWork(() => guilds, { bootDelayMs: 0, gapMs: 0 });
      await waitFor(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].every((i) => h.fm.openerFor(`e${i}`)));
      assert.equal(h.fm.openerFor('small'), null);
      assert.equal(h.fm.openerFor('e10'), null);
      assert.equal(h.adds.n, 0);
      assert.equal(h.searches.n, 0);
    } finally {
      h.close();
    }
  });

  it('leaves a prepared opener in place when the local day changes', async () => {
    const h = harness();
    try {
      h.clock.now = Date.parse('2026-10-26T22:59:59.950Z');
      h.setRows('g1', 5);
      await h.fm.prepareNext({ id: 'g1', name: 'Kitchen' });
      const stored = h.fm.openerFor('g1');
      assert.equal(stored?.after, null);
      assert.equal(stored?.genre, 'cz-rap');
      h.fm.startBackgroundWork(() => [{ id: 'g1', name: 'Kitchen' }], {
        bootDelayMs: 60_000,
        gapMs: 0,
      });
      h.clock.now = Date.parse('2026-10-26T23:00:00.050Z');
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(h.fm.openerFor('g1'), stored);
      assert.equal(h.fm.openingGenre('g1'), 'rock');
      assert.equal(h.adds.n, 0);
    } finally {
      h.close();
    }
  });
});
