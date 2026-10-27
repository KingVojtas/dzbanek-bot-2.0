import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import {
  DEDICATION_GAP_MS,
  DedicationQueue,
  cleanDedication,
  dedicationCandidates,
  dedicationReply,
  dedicationText,
  isYouTubePlaylistLink,
  joinIntro,
  silenceMs,
} from '../src/fm/dedications';
import { FmStation } from '../src/fm/FmStation';
import { blanksIn, readLineFile } from '../src/fm/lines';
import type { FmSong } from '../src/fm/script';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function song(n: number): FmSong {
  return {
    key: `rock|${n}`,
    artist: 'Artist',
    title: `Song ${n}`,
    label: `Artist — Song ${n}`,
    query: `Artist - Song ${n}`,
    url: `https://youtu.be/s${n}`,
    durationSec: 180,
    from: { kind: 'play', userId: 'u1' },
    at: new Date('2026-10-01T00:00:00Z'),
  };
}

function show(speak: (text: string) => Promise<Buffer | null> = async () => null) {
  return new FmStation(
    {
      guild: {
        name: 'Kitchen',
        members: { cache: new Map(), fetch: async () => null },
      } as never,
      listeners: () => [{ id: 'u1', displayName: 'Vojta' }] as never,
      pool: async () => [0, 1, 2, 3, 4, 5].map(song),
      source: { youtube: { searchOne: async () => null } } as never,
      writer: { ready: false } as never,
      voice: { speak } as never,
      language: 'en',
      discover: 0,
      genres: {
        genreOf: () => undefined,
        artistId: () => undefined,
        ready: () => false,
        enqueue() {},
      },
      lines: null,
      timezone: 'Europe/Prague',
      logger: quiet as never,
    },
    () => {},
  );
}

function request(title: string): Track {
  return {
    title,
    url: `https://youtu.be/${title}`,
    durationSec: 180,
    requestedBy: 'Vojta',
    requestedById: 'u1',
  };
}

describe('isYouTubePlaylistLink', () => {
  it('rejects a playlist and keeps a single video', () => {
    assert.equal(isYouTubePlaylistLink('https://www.youtube.com/playlist?list=PLxxxx'), true);
    assert.equal(isYouTubePlaylistLink('https://youtube.com/watch?list=PLxxxx'), true);
    assert.equal(
      isYouTubePlaylistLink('https://www.youtube.com/watch?v=abc1234567&list=PLxxxx'),
      false,
    );
    assert.equal(isYouTubePlaylistLink('https://youtu.be/abc1234567?list=PLxxxx'), false);
    assert.equal(isYouTubePlaylistLink('https://open.spotify.com/playlist/abc'), false);
  });
});

describe('cleanDedication', () => {
  const names = new Map([
    ['1', 'Vojta'],
    ['2', 'Štěpán'],
  ]);

  it('turns user mentions into display names and drops the rest', () => {
    assert.equal(
      cleanDedication('hey <@1> and <@!2> in <#9> <@&3> <:cookie:4> <a:party:5>', names),
      'hey Vojta and Štěpán in',
    );
    assert.equal(
      cleanDedication('see https://example.com/a and www.radio.cz now', names),
      'see and now',
    );
    assert.equal(cleanDedication('  too   many \n spaces  ', names), 'too many spaces');
    assert.equal(cleanDedication('hi <@999>', names), 'hi');
  });

  it('trims to 120 characters and is empty when nothing is left', () => {
    assert.equal(cleanDedication('a'.repeat(130), names).length, 120);
    assert.equal(cleanDedication('   <@&1>  https://x.co  ', names), '');
    assert.equal(cleanDedication('<a:cookie:1>', names), '');
  });
});

describe('dedication replies and lines', () => {
  it('names the person and the song when there is one', () => {
    assert.equal(
      dedicationReply('Vojta', 'Štěpán', ''),
      "💌 Vojta's dedication for Štěpán is in. The DJ reads it before the next song.",
    );
    assert.equal(
      dedicationReply('Vojta', '', 'Lavazza by Viktor Sheen'),
      "💌 Vojta's dedication is in. The DJ reads it before Lavazza by Viktor Sheen.",
    );
  });

  it('joins the dedication and the set line with a short silence', () => {
    const head = Buffer.from([1, 1, 1, 1]);
    const tail = Buffer.from([2, 2, 2, 2]);
    const joined = joinIntro(head, tail);
    const gap = silenceMs(DEDICATION_GAP_MS).length;
    assert.equal(joined?.length, head.length + gap + tail.length);
    assert.equal(joined?.[0], 1);
    assert.equal(joined?.[4], 0);
    assert.equal(joined?.[joined.length - 1], 2);
    assert.equal(joinIntro(head, null), head);
    assert.equal(joinIntro(null, null), null);
  });

  it('has a line for a recipient, a song, neither, and both', () => {
    for (const language of ['en', 'cs'] as const) {
      const lines = readLineFile(language).lines.dedication;
      for (const hasTo of [false, true]) {
        for (const hasSong of [false, true]) {
          assert.ok(dedicationCandidates(lines, hasTo, hasSong).length > 0, language);
        }
      }
      const text = dedicationText(
        lines,
        {
          from: 'Vojta',
          to: 'Štěpán',
          message: 'good luck tomorrow',
          song: 'Lavazza by Viktor Sheen',
        },
        language,
        () => 0,
      );
      assert.match(text, /Vojta/);
      assert.match(text, /Štěpán/);
      assert.match(text, /good luck tomorrow/);
      assert.match(text, /Lavazza by Viktor Sheen/);
      assert.equal(blanksIn(text).length, 0);
      const plain = dedicationText(
        lines,
        { from: 'Vojta', to: '', message: 'good luck tomorrow', song: '' },
        language,
        () => 0,
      );
      assert.equal(plain.includes('Štěpán'), false);
      assert.equal(plain.includes('Lavazza'), false);
      assert.match(plain, /good luck tomorrow/);
    }
  });
});

describe('dedication limits', () => {
  it('allows one per person and three per server, and drops them when the show ends', () => {
    const station = show();
    const send = (userId: string) =>
      station.dedicate({
        userId,
        from: userId,
        to: '',
        message: 'good luck',
        track: null,
        song: '',
      });
    assert.equal(send('a'), 'ok');
    assert.equal(send('a'), 'yours');
    assert.equal(send('b'), 'ok');
    assert.equal(send('c'), 'ok');
    assert.equal(send('d'), 'full');
    assert.equal(station.pendingDedications(), 3);
    station.end();
    assert.equal(station.pendingDedications(), 0);
  });

  it('keeps a song-bound dedication behind an open one', () => {
    const queue = new DedicationQueue();
    const bound = request('Lavazza');
    queue.add({
      userId: 'a',
      from: 'A',
      to: '',
      message: 'open',
      track: null,
      song: '',
      text: 'open',
      speech: Promise.resolve(null),
    });
    queue.add({
      userId: 'b',
      from: 'B',
      to: '',
      message: 'bound',
      track: bound,
      song: 'Lavazza',
      text: 'bound',
      speech: Promise.resolve(null),
    });
    assert.equal(queue.take(request('Other'))?.message, 'open');
    assert.equal(queue.take(request('Other'))?.message, undefined);
    assert.equal(queue.take(bound)?.message, 'bound');
  });
});

describe('dedication playback', () => {
  function voice() {
    const spoken: string[] = [];
    const speak = async (text: string) => {
      spoken.push(text);
      return Buffer.alloc(4, text.includes('good luck') ? 1 : 2);
    };
    return { spoken, speak };
  }

  it('starts the clip when the dedication is accepted', () => {
    const heard = voice();
    const station = show(heard.speak);
    station.dedicate({
      userId: 'u1',
      from: 'Vojta',
      to: '',
      message: 'good luck',
      track: null,
      song: '',
    });
    assert.equal(heard.spoken.length, 1);
    assert.match(heard.spoken[0] ?? '', /good luck/);
  });

  it('is read at starting, not by an early intro, and waits for its own song', async () => {
    const heard = voice();
    const station = show(heard.speak);
    const first = await station.upNext();
    assert.ok(first);
    const early = await station.intro(first);
    const dedicated = request('Lavazza');
    station.dedicate({
      userId: 'u1',
      from: 'Vojta',
      to: 'Štěpán',
      message: 'good luck tomorrow',
      track: dedicated,
      song: 'Lavazza by Viktor Sheen',
    });
    const still = await station.intro(first);
    assert.equal(still?.text, early?.text);
    assert.equal(still?.text.includes('good luck'), false);
    station.starting(first);
    const opened = await station.intro(first);
    assert.equal(opened?.text.includes('good luck'), false);
    station.starting(dedicated);
    const read = await station.intro(dedicated);
    assert.match(read?.text ?? '', /good luck tomorrow/);
    assert.match(read?.text ?? '', /Lavazza by Viktor Sheen/);
    assert.equal(read?.text.includes(early?.text ?? 'no-set-line'), false);
  });

  it('plays the dedication before the set line when that song opens a set', async () => {
    const station = show(voice().speak);
    const first = await station.upNext();
    assert.ok(first);
    const early = await station.intro(first);
    assert.ok(early?.text);
    station.dedicate({
      userId: 'u1',
      from: 'Vojta',
      to: '',
      message: 'good luck tomorrow',
      track: first,
      song: 'Lavazza by Viktor Sheen',
    });
    const warmed = await station.intro(first);
    assert.equal(warmed?.text, early.text);
    station.starting(first);
    const live = await station.intro(first);
    assert.match(live?.text ?? '', /good luck tomorrow/);
    assert.ok(live?.text.includes(early.text));
    assert.equal(live?.pcm?.[0], 1);
    assert.equal(live?.pcm?.[live.pcm.length - 1], 2);
    assert.equal(live?.pcm?.length, 4 + silenceMs(DEDICATION_GAP_MS).length + 4);
  });
});
