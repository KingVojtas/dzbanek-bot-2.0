import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catchBlockReason,
  decodeIcyBytes,
  icyCover,
  isGenericTitle,
  parseIcyMeta,
  parseTritonNow,
  splitIcyTitle,
} from '../src/radio/now-playing';
import { STATIONS } from '../src/radio/station';

describe('parseIcyMeta', () => {
  it('reads Heart’s title and ignores the rest', () => {
    const meta =
      "StreamTitle='Black Eyed Peas - Where Is The Love?';StreamUrl='';inf='LZTHW';track_info='k4S';";
    assert.deepEqual(parseIcyMeta(meta), {
      title: 'Black Eyed Peas - Where Is The Love?',
      streamUrl: null,
    });
  });

  it('keeps an apostrophe inside the title', () => {
    const meta = "StreamTitle='Kylie Minogue - Can't Get You Out Of My Head';StreamUrl='';";
    assert.equal(parseIcyMeta(meta)?.title, "Kylie Minogue - Can't Get You Out Of My Head");
  });

  it('is null for Capital’s blank title between songs', () => {
    assert.equal(parseIcyMeta("StreamTitle='';StreamUrl='';inf='LZEQX';"), null);
  });

  it('reads Radio Paradise’s cover from StreamUrl', () => {
    const meta =
      "StreamTitle='Hermanos Gutiérrez - Los Andes';StreamUrl='http://img.radioparadise.com/covers/l/29184.jpg';";
    const parsed = parseIcyMeta(meta);
    assert.equal(parsed?.title, 'Hermanos Gutiérrez - Los Andes');
    assert.equal(icyCover(parsed!.streamUrl), 'https://img.radioparadise.com/covers/l/29184.jpg');
  });
});

describe('icyCover', () => {
  it('takes only image URLs', () => {
    assert.equal(icyCover(null), undefined);
    assert.equal(icyCover('https://www.example.com/'), undefined);
    assert.equal(
      icyCover('https://cdn.example.com/a.png?w=300'),
      'https://cdn.example.com/a.png?w=300',
    );
  });
});

describe('parseTritonNow', () => {
  const xml = (startMs: number) =>
    '<?xml version="1.0" encoding="UTF-8"?><nowplaying-info-list>' +
    `<nowplaying-info mountName="FREKVENCE1" timestamp="1792855091" type="track">` +
    '<property name="cue_time_duration"><![CDATA[000]]></property>' +
    `<property name="cue_time_start"><![CDATA[${startMs}]]></property>` +
    '<property name="cue_title"><![CDATA[Drive Safe]]></property>' +
    '<property name="track_artist_name"><![CDATA[MYLES SMITH & NIALL HORAN]]></property>' +
    '</nowplaying-info>' +
    '<nowplaying-info mountName="FREKVENCE1" timestamp="1792854769" type="track">' +
    '<property name="cue_title"><![CDATA[Older Song]]></property>' +
    '</nowplaying-info></nowplaying-info-list>';

  it('reads the newest track', () => {
    const start = 1_792_855_091_683;
    assert.deepEqual(parseTritonNow(xml(start), start + 60_000), {
      artist: 'MYLES SMITH & NIALL HORAN',
      title: 'Drive Safe',
    });
  });

  it('drops a track that started over 20 minutes ago', () => {
    const start = 1_792_855_091_683;
    assert.equal(parseTritonNow(xml(start), start + 21 * 60_000), null);
  });

  it('is null for an empty list', () => {
    assert.equal(
      parseTritonNow('<?xml version="1.0"?><nowplaying-info-list></nowplaying-info-list>'),
      null,
    );
  });
});

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
