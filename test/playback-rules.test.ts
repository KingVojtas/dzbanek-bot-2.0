import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StationIntro } from '../src/core/types';
import {
  INTRO_WAIT_MS,
  LONG_INTRO_WAIT_MS,
  introIsLong,
  lateVoiceLine,
  playSuperseded,
  showIntroCard,
  stationSpeaks,
  streamStartedLine,
} from '../src/music/playback-rules';

describe('introIsLong', () => {
  it('treats a break-length wait as long, and a missing wait as short', () => {
    assert.equal(INTRO_WAIT_MS < LONG_INTRO_WAIT_MS, true);
    assert.equal(introIsLong(null), false);
    assert.equal(introIsLong(LONG_INTRO_WAIT_MS - 1), false);
    assert.equal(introIsLong(LONG_INTRO_WAIT_MS), true);
  });
});

describe('stationSpeaks', () => {
  const station = { name: 'fm' };

  it('speaks for a new song and stays quiet on a repeat or with no station', () => {
    assert.equal(stationSpeaks(station, false), true);
    assert.equal(stationSpeaks(station, true), false);
    assert.equal(stationSpeaks(null, false), false);
  });
});

describe('showIntroCard', () => {
  const intro: StationIntro = { text: 'Hello', pcm: null };

  it('shows the line unless the song has already failed', () => {
    assert.equal(showIntroCard(intro, false), true);
    assert.equal(showIntroCard(intro, true), false);
    assert.equal(showIntroCard(null, false), false);
  });
});

describe('playSuperseded', () => {
  it('stops a play the player left behind', () => {
    assert.equal(playSuperseded(false, true), false);
    assert.equal(playSuperseded(true, true), true);
    assert.equal(playSuperseded(false, false), true);
  });
});

describe('stream and voice lines', () => {
  it('names a fresh start and a prefetched one', () => {
    assert.equal(
      streamStartedLine({ title: 'Lavazza', readySec: '1.5', prefetched: false, queued: 2 }),
      'Audio player started: Lavazza (stream ready in 1.5 s; 2 still queued)',
    );
    assert.equal(
      streamStartedLine({ title: 'Lavazza', readySec: '0.2', prefetched: true, queued: 0 }),
      'Audio player started: Lavazza (stream ready in 0.2 s, prefetched; 0 still queued)',
    );
  });

  it('names a greeting that arrived after the wait', () => {
    assert.equal(
      lateVoiceLine('8.0'),
      'Kitchen FM voice: ready after the player stopped waiting (8.0 s)',
    );
  });
});
