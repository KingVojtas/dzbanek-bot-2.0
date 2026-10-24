import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catchBlockReason,
  decodeIcyBytes,
  isGenericTitle,
  splitIcyTitle,
} from '../src/radio/now-playing';
import { STATIONS } from '../src/radio/station';

describe('splitIcyTitle', () => {
  it('splits "Artist - Title"', () => {
    assert.deepEqual(splitIcyTitle('Black Eyed Peas - Where Is The Love?'), {
      artist: 'Black Eyed Peas',
      title: 'Where Is The Love?',
    });
  });

  it('keeps later dashes in the title', () => {
    assert.deepEqual(splitIcyTitle('Artist - Song - Radio Edit'), {
      artist: 'Artist',
      title: 'Song - Radio Edit',
    });
  });

  it('keeps a hyphenated word whole', () => {
    assert.deepEqual(splitIcyTitle('a-ha'), { artist: null, title: 'a-ha' });
  });
});

describe('isGenericTitle', () => {
  it('treats an empty title or the station name as no song', () => {
    assert.equal(isGenericTitle('', STATIONS.kiss), true);
    assert.equal(isGenericTitle('Radio Kiss', STATIONS.kiss), true);
    assert.equal(isGenericTitle('Radio Beat - Classic Rock', STATIONS.beat), true);
  });

  it('lets a real song through', () => {
    assert.equal(isGenericTitle('Toto - Africa', STATIONS.kiss), false);
  });
});

describe('catchBlockReason', () => {
  it('allows a real song', () => {
    assert.equal(catchBlockReason({ artist: 'Toto', title: 'Africa' }, STATIONS.rock), null);
  });

  it('refuses a show with no artist', () => {
    assert.ok(catchBlockReason({ artist: null, title: 'Hard & Heavy' }, STATIONS.beat));
  });

  it('refuses nothing on air', () => {
    assert.ok(catchBlockReason(null, STATIONS.beat));
  });
});

describe('decodeIcyBytes', () => {
  it('reads UTF-8 and falls back to windows-1250', () => {
    assert.equal(decodeIcyBytes(Buffer.from('Žluťoučký kůň', 'utf8')), 'Žluťoučký kůň');
    assert.equal(decodeIcyBytes(Buffer.from([0x8e, 0x6c, 0x75, 0x9d])), 'Žluť');
  });
});
