import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import {
  EARLY_BY_SEC,
  HISTORY_MAX,
  INSTANT_END_MS,
  STATION_MISSES,
  afterTrackEnds,
  earlyEndWarning,
  idleOutcome,
  pushHistory,
  shouldAskStation,
  stationPickStale,
  takeNext,
  type EarlyEnd,
  type TrackEnd,
} from '../src/music/queue-rules';

function track(name: string): Track {
  return { title: name, url: `https://youtu.be/${name}`, durationSec: 200, requestedBy: 'tester' };
}

function ended(overrides: Partial<TrackEnd> = {}): TrackEnd {
  return {
    finished: track('a'),
    playedMs: 120_000,
    skipRequested: false,
    goingBack: false,
    loopMode: 'off',
    retriedUrl: null,
    ...overrides,
  };
}

function early(overrides: Partial<EarlyEnd> = {}): EarlyEnd {
  const finished = track('Lavazza');
  finished.durationSec = 224;
  return {
    ...ended({ finished, playedMs: 151_000 }),
    prefetched: false,
    stopped: false,
    ...overrides,
  };
}

describe('afterTrackEnds', () => {
  it('sends a finished track to history', () => {
    assert.equal(afterTrackEnds(ended()), 'history');
  });

  it('retries a track that ended instantly the first time', () => {
    assert.equal(afterTrackEnds(ended({ playedMs: INSTANT_END_MS - 1 })), 'retry');
  });

  it('gives up on a track that ended instantly after its retry', () => {
    const end = ended({ playedMs: 0, retriedUrl: 'https://youtu.be/a' });
    assert.equal(afterTrackEnds(end), 'give-up');
  });

  it('does not retry a skip, however short', () => {
    assert.equal(afterTrackEnds(ended({ playedMs: 10, skipRequested: true })), 'history');
  });

  it('counts exactly the threshold as a real play', () => {
    assert.equal(afterTrackEnds(ended({ playedMs: INSTANT_END_MS })), 'history');
  });

  it('puts the track back on loop-track', () => {
    assert.equal(afterTrackEnds(ended({ loopMode: 'track' })), 'requeue');
  });

  it('lets skip leave a looped track', () => {
    assert.equal(afterTrackEnds(ended({ loopMode: 'track', skipRequested: true })), 'history');
  });

  it('leaves loop-queue tracks to the snapshot', () => {
    assert.equal(afterTrackEnds(ended({ loopMode: 'queue' })), 'history');
  });

  it('does nothing when previous() already placed the track', () => {
    const end = ended({ goingBack: true, skipRequested: true, playedMs: 5_000 });
    assert.equal(afterTrackEnds(end), 'none');
  });

  it('does nothing when no track was playing', () => {
    assert.equal(afterTrackEnds(ended({ finished: null, playedMs: 0 })), 'none');
  });
});

describe('earlyEndWarning', () => {
  it('names a song that finished well short of its length', () => {
    assert.equal(
      earlyEndWarning(early({ prefetched: true })),
      'Track "Lavazza" ended early: played 2:31 of 3:44 (prefetched).',
    );
    assert.equal(earlyEndWarning(early()), 'Track "Lavazza" ended early: played 2:31 of 3:44.');
  });

  it('stays quiet for a full song, a skip, a stop, previous, and a retry', () => {
    const full = 224_000;
    assert.equal(earlyEndWarning(early({ playedMs: full })), null);
    assert.equal(earlyEndWarning(early({ playedMs: (224 - EARLY_BY_SEC) * 1000 })), null);
    assert.equal(earlyEndWarning(early({ skipRequested: true })), null);
    assert.equal(earlyEndWarning(early({ stopped: true })), null);
    assert.equal(earlyEndWarning(early({ goingBack: true, skipRequested: true })), null);
    assert.equal(earlyEndWarning(early({ playedMs: INSTANT_END_MS - 1 })), null);
    assert.equal(
      earlyEndWarning(early({ playedMs: 0, retriedUrl: 'https://youtu.be/Lavazza' })),
      null,
    );
    const live = track('live');
    live.durationSec = 0;
    assert.equal(earlyEndWarning(early({ finished: live })), null);
  });

  it('warns when a looped song ends on its own, short of its length', () => {
    assert.match(earlyEndWarning(early({ loopMode: 'track' })) ?? '', /ended early/);
  });
});

describe('pushHistory', () => {
  it('keeps only the newest tracks', () => {
    const history: Track[] = [];
    for (let i = 0; i < HISTORY_MAX + 5; i++) pushHistory(history, track(String(i)));
    assert.equal(history.length, HISTORY_MAX);
    assert.equal(history[0]!.title, '5');
    assert.equal(history.at(-1)!.title, String(HISTORY_MAX + 4));
  });
});

describe('takeNext', () => {
  it('takes from the front of the queue', () => {
    const queue = [track('a'), track('b')];
    assert.equal(takeNext(queue, 'off', [])?.title, 'a');
    assert.deepEqual(
      queue.map((t) => t.title),
      ['b'],
    );
  });

  it('returns nothing when the queue is empty and not looping', () => {
    assert.equal(takeNext([], 'off', [track('a')]), undefined);
    assert.equal(takeNext([], 'track', [track('a')]), undefined);
  });

  it('refills an empty queue from the loop-queue snapshot', () => {
    const queue: Track[] = [];
    const snapshot = [track('a'), track('b'), track('c')];
    assert.equal(takeNext(queue, 'queue', snapshot)?.title, 'a');
    assert.deepEqual(
      queue.map((t) => t.title),
      ['b', 'c'],
    );
    assert.equal(snapshot.length, 3);
  });

  it('returns nothing on loop-queue with no snapshot', () => {
    assert.equal(takeNext([], 'queue', []), undefined);
  });
});

describe('shouldAskStation', () => {
  it('asks only while the queue is empty and misses are under the cap', () => {
    assert.equal(shouldAskStation(undefined, 0), true);
    assert.equal(shouldAskStation(undefined, STATION_MISSES - 1), true);
    assert.equal(shouldAskStation(undefined, STATION_MISSES), false);
    assert.equal(shouldAskStation(track('a'), 0), false);
  });
});

describe('stationPickStale', () => {
  it('looks again when the station changed or a request arrived', () => {
    assert.equal(stationPickStale(true, 0), false);
    assert.equal(stationPickStale(true, 1), true);
    assert.equal(stationPickStale(false, 0), true);
  });
});

describe('idleOutcome', () => {
  it('retries with the fresh-stream warning', () => {
    assert.deepEqual(idleOutcome('retry', 'Lavazza'), {
      kind: 'retry',
      warn: 'Track "Lavazza" ended immediately — retrying with a fresh stream.',
    });
  });

  it('gives up with the skip warning and the error the card keeps', () => {
    assert.deepEqual(idleOutcome('give-up', 'Lavazza'), {
      kind: 'give-up',
      warn: 'Track "Lavazza" ended immediately again — skipping it.',
      error: '"Lavazza" ended immediately twice.',
    });
  });

  it('puts a looped track back and sends a finished one to history', () => {
    assert.deepEqual(idleOutcome('requeue', 'Lavazza'), {
      kind: 'continue',
      requeue: true,
      history: false,
    });
    assert.deepEqual(idleOutcome('history', 'Lavazza'), {
      kind: 'continue',
      requeue: false,
      history: true,
    });
    assert.deepEqual(idleOutcome('none', 'Lavazza'), {
      kind: 'continue',
      requeue: false,
      history: false,
    });
  });
});
