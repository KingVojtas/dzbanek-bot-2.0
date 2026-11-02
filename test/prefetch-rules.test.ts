import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dropPrefetchOnStationChange,
  hasPreloadedAudio,
  prefetchedStreamReady,
  prefetchIsStale,
  queuedPrefetchKeep,
  stationPrefetchBlocked,
  stationPrefetchKeep,
  stationWarmsAhead,
  upcomingHeld,
} from '../src/music/prefetch-rules';

const fresh = {
  drop: false,
  destroyed: false,
  taken: false,
  sameGeneration: true,
  keep: () => true,
};

describe('prefetchIsStale', () => {
  it('drops a prefetch the play no longer wants', () => {
    assert.equal(prefetchIsStale(fresh), false);
    assert.equal(prefetchIsStale({ ...fresh, drop: true }), true);
    assert.equal(prefetchIsStale({ ...fresh, destroyed: true }), true);
    assert.equal(prefetchIsStale({ ...fresh, sameGeneration: false }), true);
    assert.equal(prefetchIsStale({ ...fresh, keep: () => false }), true);
  });

  it('keeps a taken slot, and does not ask keep once the slot is no longer eligible', () => {
    let asks = 0;
    const keep = (): boolean => {
      asks += 1;
      return false;
    };
    assert.equal(prefetchIsStale({ ...fresh, taken: true, sameGeneration: false, keep }), false);
    assert.equal(prefetchIsStale({ ...fresh, drop: true, keep }), true);
    assert.equal(prefetchIsStale({ ...fresh, destroyed: true, keep }), true);
    assert.equal(prefetchIsStale({ ...fresh, sameGeneration: false, keep }), true);
    assert.equal(asks, 0);
    assert.equal(prefetchIsStale({ ...fresh, keep }), true);
    assert.equal(asks, 1);
  });
});

describe('prefetchedStreamReady', () => {
  const ready = {
    drop: false,
    hasStream: true,
    usable: true,
    destroyed: false,
    sameGeneration: true,
  };

  it('plays the warmed stream only when every check holds', () => {
    assert.equal(prefetchedStreamReady(ready), true);
    assert.equal(prefetchedStreamReady({ ...ready, drop: true }), false);
    assert.equal(prefetchedStreamReady({ ...ready, hasStream: false }), false);
    assert.equal(prefetchedStreamReady({ ...ready, usable: false }), false);
    assert.equal(prefetchedStreamReady({ ...ready, destroyed: true }), false);
    assert.equal(prefetchedStreamReady({ ...ready, sameGeneration: false }), false);
  });
});

describe('hasPreloadedAudio', () => {
  it('accepts a buffer that has bytes', () => {
    assert.equal(hasPreloadedAudio(undefined), false);
    assert.equal(hasPreloadedAudio(Buffer.alloc(0)), false);
    assert.equal(hasPreloadedAudio(Buffer.from('pcm')), true);
  });
});

describe('prefetch keep', () => {
  it('keeps a queued request only while that url is still next', () => {
    assert.equal(queuedPrefetchKeep('https://youtu.be/a', 'https://youtu.be/a'), true);
    assert.equal(queuedPrefetchKeep('https://youtu.be/b', 'https://youtu.be/a'), false);
    assert.equal(queuedPrefetchKeep(undefined, 'https://youtu.be/a'), false);
  });

  it('keeps a station pick while that show is on, the queue is not looping, and the url matches', () => {
    const keep = {
      sameStation: true,
      loopMode: 'off' as const,
      stationUrl: 'https://youtu.be/a',
      url: 'https://youtu.be/a',
    };
    assert.equal(stationPrefetchKeep(keep), true);
    assert.equal(stationPrefetchKeep({ ...keep, sameStation: false }), false);
    assert.equal(stationPrefetchKeep({ ...keep, loopMode: 'track' }), false);
    assert.equal(stationPrefetchKeep({ ...keep, loopMode: 'queue' }), false);
    assert.equal(stationPrefetchKeep({ ...keep, stationUrl: 'https://youtu.be/b' }), false);
    assert.equal(stationPrefetchKeep({ ...keep, stationUrl: undefined }), false);
  });
});

describe('station prefetch guards', () => {
  it('blocks a warm when the show changed, a request is waiting, or the queue loops', () => {
    const open = {
      destroyed: false,
      sameStation: true,
      loopMode: 'off' as const,
      requestWaiting: false,
    };
    assert.equal(stationPrefetchBlocked(open), false);
    assert.equal(stationPrefetchBlocked({ ...open, destroyed: true }), true);
    assert.equal(stationPrefetchBlocked({ ...open, sameStation: false }), true);
    assert.equal(stationPrefetchBlocked({ ...open, loopMode: 'queue' }), true);
    assert.equal(stationPrefetchBlocked({ ...open, requestWaiting: true }), true);
  });

  it('warms ahead only while the queue is not looping', () => {
    assert.equal(stationWarmsAhead('off'), true);
    assert.equal(stationWarmsAhead('track'), false);
    assert.equal(stationWarmsAhead('queue'), false);
  });

  it('holds an upcoming pick only for the same station, still not looping', () => {
    assert.equal(upcomingHeld(true, 'off'), true);
    assert.equal(upcomingHeld(false, 'off'), false);
    assert.equal(upcomingHeld(true, 'track'), false);
  });

  it('drops a warm that is no longer the queued request', () => {
    assert.equal(dropPrefetchOnStationChange('https://youtu.be/a', 'https://youtu.be/a'), false);
    assert.equal(dropPrefetchOnStationChange('https://youtu.be/a', 'https://youtu.be/b'), true);
    assert.equal(dropPrefetchOnStationChange(undefined, 'https://youtu.be/a'), true);
    assert.equal(dropPrefetchOnStationChange('https://youtu.be/a', undefined), true);
  });
});
