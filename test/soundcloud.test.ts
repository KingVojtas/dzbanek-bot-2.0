import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import { pickStandIn, soundCloudQuery } from '../src/music/sources/soundcloud';

function track(title: string, durationSec: number, uploader?: string): Track {
  return { title, url: 'https://youtu.be/x', durationSec, requestedBy: 'tester', uploader };
}

describe('soundCloudQuery', () => {
  it('drops YouTube dressing and keeps "Artist - Song"', () => {
    assert.equal(
      soundCloudQuery(track('Daft Punk - Get Lucky (Official Video)', 248, 'DaftPunkVEVO')),
      'Daft Punk - Get Lucky',
    );
  });

  it('leaves out the featured artists', () => {
    assert.equal(
      soundCloudQuery(track('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams', 248)),
      'Daft Punk - Get Lucky',
    );
  });

  it('puts the channel in front of a bare song name', () => {
    assert.equal(
      soundCloudQuery(track('Vzpoura strojů', 199, 'JAMES COLE official channel')),
      'JAMES COLE Vzpoura strojů',
    );
  });
});

describe('pickStandIn', () => {
  const lucky = track('Daft Punk - Get Lucky (Official Audio)', 248);

  it('takes the upload with the song name and the same length', () => {
    const url = pickStandIn(lucky, [
      { title: 'Daft Punk - Get Lucky #nightcore', duration: 247, url: 'nightcore' },
      { title: 'Get Lucky [Original Version] - Daft Punk', duration: 246.4, url: 'original' },
    ]);
    assert.equal(url, 'original');
  });

  it('skips 30 s previews and songs of another length', () => {
    assert.equal(
      pickStandIn(lucky, [
        { title: 'Get Lucky', duration: 30, url: 'preview' },
        { title: 'Get Lucky', duration: 326, url: 'extended' },
      ]),
      null,
    );
  });

  it('matches across accents and case', () => {
    const url = pickStandIn(track('Vzpoura strojů', 199), [
      { title: 'Lil Fresh- Vzpoura Strojů', duration: 120, url: 'other song' },
      { title: 'VZPOURA STROJU', uploader: 'James Cole', duration: 200, url: 'cole' },
    ]);
    assert.equal(url, 'cole');
  });

  it('never guesses without a known length', () => {
    assert.equal(
      pickStandIn(track('Get Lucky', 0), [{ title: 'Get Lucky', duration: 200, url: 'x' }]),
      null,
    );
  });
});
