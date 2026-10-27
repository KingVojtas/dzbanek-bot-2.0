import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zonedDateTimeToUtc } from '../src/kitchen/time';
import { kitchenWrapped, musicBits, type WrappedPlay } from '../src/kitchen/wrapped';

const TZ = 'Europe/Prague';

function at(dateKey: string, hour = 12): Date {
  return zonedDateTimeToUtc(TZ, dateKey, hour, 0);
}

function play(
  partial: Partial<WrappedPlay> & Pick<WrappedPlay, 'songKey' | 'playedAt'>,
): WrappedPlay {
  return {
    title: partial.title ?? partial.songKey,
    artist: partial.artist ?? 'Artist',
    songKey: partial.songKey,
    requestedById: partial.requestedById ?? null,
    kind: partial.kind ?? 'play',
    durationSec: partial.durationSec ?? 0,
    playedAt: partial.playedAt,
  };
}

const october = { label: 'October 2026', yearly: false, startKey: '2026-10-01' };

describe('musicBits', () => {
  it('names songs alone until a minute, then minutes, then hours', () => {
    assert.deepEqual(musicBits(3, 20), { songs: '3 songs', length: null });
    assert.deepEqual(musicBits(1, 90), { songs: '1 song', length: '2 minutes' });
    assert.deepEqual(musicBits(128, 18 * 3600), { songs: '128 songs', length: '18 hours' });
    assert.deepEqual(musicBits(4, 3600), { songs: '4 songs', length: '1 hour' });
  });
});

describe('kitchenWrapped', () => {
  const base = {
    period: october,
    timeZone: TZ,
    catches: [] as { userId: string; stationId: string }[],
    reactions: [] as { songKey: string; title: string; artist: string; kind: string }[],
    champion: null,
    genreOf: () => undefined as string | undefined,
    nameOf: (id: string) => id,
    stationName: (id: string) => id,
  };

  it('sums songs and seconds, and ranks the top songs', () => {
    const stats = kitchenWrapped({
      ...base,
      plays: [
        play({
          songKey: 'a',
          title: 'Alpha',
          playedAt: at('2026-10-02'),
          durationSec: 100,
          kind: 'fm',
        }),
        play({ songKey: 'a', title: 'Alpha', playedAt: at('2026-10-03'), durationSec: 50 }),
        play({ songKey: 'b', title: 'Beta', playedAt: at('2026-10-04'), durationSec: 10 }),
      ],
    });
    assert.equal(stats.songs, 3);
    assert.equal(stats.durationSec, 160);
    assert.deepEqual(
      stats.topSongs.map((song) => song.title),
      ['Alpha', 'Beta'],
    );
    assert.equal(stats.topSongs[0]?.plays, 2);
  });

  it('counts play and dedication rows plus catches, and skips station picks', () => {
    const stats = kitchenWrapped({
      ...base,
      nameOf: (id) => ({ vojta: 'Vojta', anna: 'Anna', petr: 'Petr' })[id] ?? '',
      plays: [
        play({ songKey: 'a', playedAt: at('2026-10-02'), requestedById: 'vojta', kind: 'play' }),
        play({ songKey: 'a', playedAt: at('2026-10-03'), requestedById: 'vojta', kind: 'play' }),
        play({
          songKey: 'b',
          playedAt: at('2026-10-04'),
          requestedById: 'vojta',
          kind: 'dedication',
        }),
        play({ songKey: 'c', playedAt: at('2026-10-05'), requestedById: 'vojta', kind: 'fm' }),
        play({ songKey: 'd', playedAt: at('2026-10-05'), requestedById: 'anna', kind: 'play' }),
        play({ songKey: 'e', playedAt: at('2026-10-06'), requestedById: 'ghost', kind: 'play' }),
      ],
      catches: [
        { userId: 'anna', stationId: 'beat' },
        { userId: 'anna', stationId: 'beat' },
        { userId: 'petr', stationId: 'kiss' },
      ],
    });
    assert.deepEqual(
      stats.people.map((person) => [person.name, person.songs]),
      [
        ['Anna', 3],
        ['Vojta', 3],
        ['Petr', 1],
      ],
    );
  });

  it('names a favourite genre once five plays have one, as a share of those plays', () => {
    const plays = [
      ...['a', 'a', 'a', 'b', 'b'].map((songKey, i) =>
        play({ songKey, playedAt: at(`2026-10-0${i + 1}`) }),
      ),
      play({ songKey: 'unknown', playedAt: at('2026-10-08') }),
    ];
    const genreOf = (key: string) => (key === 'a' ? 'Czech rap' : key === 'b' ? 'rock' : undefined);
    const hidden = kitchenWrapped({
      ...base,
      plays: plays.slice(0, 4),
      genreOf,
    });
    assert.equal(hidden.genre, undefined);
    const shown = kitchenWrapped({ ...base, plays, genreOf });
    assert.deepEqual(shown.genre, { name: 'Czech rap', share: 60 });
  });

  it('picks the fire song, the station, and the quiz champion', () => {
    const stats = kitchenWrapped({
      ...base,
      plays: [play({ songKey: 'a', playedAt: at('2026-10-02') })],
      reactions: [
        { songKey: 'hot', title: 'Numb', artist: 'Linkin Park', kind: 'fire' },
        { songKey: 'hot', title: 'Numb', artist: 'Linkin Park', kind: 'fire' },
        { songKey: 'cold', title: 'Other', artist: 'Band', kind: 'fire' },
        { songKey: 'hot', title: 'Numb', artist: 'Linkin Park', kind: 'nope' },
      ],
      catches: [
        { userId: 'a', stationId: 'beat' },
        { userId: 'b', stationId: 'beat' },
        { userId: 'c', stationId: 'kiss' },
      ],
      stationName: (id) => (id === 'beat' ? 'Radio Beat' : 'Kiss Radio'),
      champion: { name: 'Vojta', score: 1240, games: 3 },
    });
    assert.deepEqual(stats.fire, { title: 'Numb', artist: 'Linkin Park', fires: 2 });
    assert.deepEqual(stats.station, { name: 'Radio Beat', catches: 2 });
    assert.equal(stats.quiz?.name, 'Vojta');
  });

  it('keeps a find only when its first row in the window is a find and someone fires it', () => {
    const stats = kitchenWrapped({
      ...base,
      plays: [
        play({ songKey: 'kept', title: 'Kept', kind: 'find', playedAt: at('2026-10-02') }),
        play({ songKey: 'kept', title: 'Kept', kind: 'fm', playedAt: at('2026-10-09') }),
        play({ songKey: 'old', title: 'Old', kind: 'play', playedAt: at('2026-10-03') }),
        play({ songKey: 'old', title: 'Old', kind: 'find', playedAt: at('2026-10-10') }),
        play({ songKey: 'quiet', title: 'Quiet', kind: 'find', playedAt: at('2026-10-04') }),
      ],
      reactions: [
        { songKey: 'kept', title: 'Kept', artist: 'A', kind: 'fire' },
        { songKey: 'kept', title: 'Kept', artist: 'A', kind: 'fire' },
        { songKey: 'old', title: 'Old', artist: 'B', kind: 'fire' },
        { songKey: 'missing', title: 'Nope', artist: 'C', kind: 'fire' },
      ],
    });
    assert.equal(stats.finds?.count, 1);
    assert.equal(stats.finds?.songs[0]?.title, 'Kept');
  });

  it('says since when the first play is on a later day than the period opens', () => {
    const later = kitchenWrapped({
      ...base,
      plays: [play({ songKey: 'a', playedAt: at('2026-10-27') })],
    });
    assert.equal(later.since, '27 October');

    const opening = kitchenWrapped({
      ...base,
      plays: [play({ songKey: 'a', playedAt: at('2026-10-01', 18) })],
    });
    assert.equal(opening.since, undefined);

    const year = kitchenWrapped({
      ...base,
      period: { label: '2026', yearly: true, startKey: '2026-01-01' },
      plays: [play({ songKey: 'a', playedAt: at('2026-10-27') })],
    });
    assert.equal(year.since, '27 October 2026');
  });

  it('is empty when nothing played', () => {
    const stats = kitchenWrapped({ ...base, plays: [] });
    assert.equal(stats.songs, 0);
    assert.equal(stats.since, undefined);
    assert.deepEqual(stats.topSongs, []);
    assert.deepEqual(stats.people, []);
  });
});
