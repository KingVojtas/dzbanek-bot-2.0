import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StationIntro } from '../src/core/types';
import {
  OPENING_READY_MS,
  firstSongGreeting,
  greetingToPlay,
  idleEndsTrack,
  introWaitAfterOpening,
  openSongStreamNow,
  openingLateLine,
  openingPlay,
  openingPlayedLine,
} from '../src/music/opening-rules';

const USUAL_MS = 12_000;
const LONG_MS = 60_000;

function intro(pcm: Buffer | null, text = 'Hello'): StationIntro {
  return { text, pcm };
}

describe('openingPlay', () => {
  const ready = { destroyed: false, busy: false, elapsedMs: 100, hasPcm: true };

  it('plays a clip that arrived while nothing else is on', () => {
    assert.equal(openingPlay(ready), 'play');
  });

  it('skips a clip that was not ready within 2 seconds', () => {
    assert.equal(openingPlay({ ...ready, elapsedMs: OPENING_READY_MS }), 'late');
    assert.equal(openingPlay({ ...ready, elapsedMs: OPENING_READY_MS - 1 }), 'play');
  });

  it('stays quiet when a song or the DJ is already on', () => {
    assert.equal(openingPlay({ ...ready, busy: true }), 'busy');
  });

  it('does not play an empty clip', () => {
    assert.equal(openingPlay({ ...ready, hasPcm: false }), 'empty');
  });

  it('does nothing once the player is gone', () => {
    assert.equal(openingPlay({ ...ready, destroyed: true, elapsedMs: OPENING_READY_MS }), 'gone');
  });
});

describe('intro wait after the opening', () => {
  it('does not start the wait while the opening jingle is still playing', () => {
    assert.equal(introWaitAfterOpening(false, LONG_MS, USUAL_MS), null);
  });

  it('uses the station wait once the opening has finished', () => {
    assert.equal(introWaitAfterOpening(true, LONG_MS, USUAL_MS), LONG_MS);
    assert.equal(introWaitAfterOpening(true, 8_000, USUAL_MS), 8_000);
  });

  it('uses the usual wait when the station does not name one', () => {
    assert.equal(introWaitAfterOpening(true, undefined, USUAL_MS), USUAL_MS);
  });

  it('opens the song stream during the opening, and waits out a long break after it', () => {
    assert.equal(
      openSongStreamNow({ openingSettled: false, longIntro: true, prefetched: false }),
      true,
    );
    assert.equal(
      openSongStreamNow({ openingSettled: true, longIntro: true, prefetched: false }),
      false,
    );
    assert.equal(
      openSongStreamNow({ openingSettled: true, longIntro: true, prefetched: true }),
      true,
    );
    assert.equal(
      openSongStreamNow({ openingSettled: true, longIntro: false, prefetched: false }),
      true,
    );
  });
});

describe('greetingToPlay', () => {
  const full = intro(Buffer.from('full'), 'full line');
  const backup = intro(Buffer.from('backup'), 'backup line');

  it('plays the full greeting when it has audio', () => {
    assert.deepEqual(greetingToPlay(full, backup), { intro: full, heard: 'spoken' });
  });

  it('uses the backup when the full greeting has no audio or never arrived', () => {
    assert.deepEqual(greetingToPlay(intro(null, 'full line'), backup), {
      intro: backup,
      heard: 'backup',
    });
    assert.deepEqual(greetingToPlay(null, backup), { intro: backup, heard: 'backup' });
    assert.deepEqual(greetingToPlay(intro(Buffer.alloc(0)), backup), {
      intro: backup,
      heard: 'backup',
    });
  });

  it('keeps a text-only line when there is no backup clip either', () => {
    const text = intro(null, 'full line');
    assert.deepEqual(greetingToPlay(text, null), { intro: text, heard: 'none' });
    assert.deepEqual(greetingToPlay(text, intro(Buffer.alloc(0))), { intro: text, heard: 'none' });
    assert.deepEqual(greetingToPlay(null, null), { intro: null, heard: 'none' });
  });
});

describe('idleEndsTrack', () => {
  it('does not end a track while an opening clip or the queue pump is running', () => {
    assert.equal(idleEndsTrack({ clip: true, queueRunning: false }), false);
    assert.equal(idleEndsTrack({ clip: false, queueRunning: true }), false);
    assert.equal(idleEndsTrack({ clip: false, queueRunning: false }), true);
  });
});

describe('firstSongGreeting', () => {
  it('names a prepared clip, a fresh one, the backup, or none', () => {
    assert.equal(firstSongGreeting({ heard: 'spoken', preparedClip: true }), 'prepared');
    assert.equal(firstSongGreeting({ heard: 'spoken', preparedClip: false }), 'fresh');
    assert.equal(firstSongGreeting({ heard: 'backup', preparedClip: true }), 'backup');
    assert.equal(firstSongGreeting({ heard: 'none', preparedClip: true }), 'none');
  });
});

describe('opening lines', () => {
  it('names a late clip and a clip that started', () => {
    assert.equal(
      openingLateLine('Kitchen'),
      'Kitchen FM in Kitchen: opening jingle skipped, not ready in time.',
    );
    assert.equal(
      openingPlayedLine('Kitchen', 'id-main', '3.2'),
      'Kitchen FM in Kitchen: opening jingle id-main (3.2 s).',
    );
  });
});
