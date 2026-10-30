import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyBed,
  breakTailReserve,
  emptyBreak,
  joinBreak,
  renderBreakHead,
  renderBreakTail,
  takeBreakLine,
  BREAK_SPEAK_MS,
  BREAK_TAIL_SEC,
  type BreakFiles,
  type BreakSpeak,
  type BreakUsed,
  type BreakVoices,
} from '../src/fm/break-show';
import {
  fillBreak,
  loadBreakBook,
  BREAK_PARTS,
  type BreakBook,
  type BreakSlots,
} from '../src/fm/breaks';
import { BED_TARGET_DB } from '../src/fm/jingles';
import { pcmLoudness } from '../src/fm/voice';
import { BREAK_GAP_SECONDS, CHIME_SECONDS, breakGap, stationChime } from '../src/fm/stinger';
import {
  INTRO_MARGIN_MS,
  INTRO_MIN_MS,
  LONG_INTRO_SEC,
  PCM_BYTES_PER_SEC,
  STREAM_LEAD_SEC,
  introPlayMs,
  pcmSeconds,
  streamOpenDelayMs,
} from '../src/music/intro-wait';

const FULL: BreakSlots = {
  server: 'Kitchen',
  lastGenre: 'rock',
  artists: 'A, B and C',
  genre: 'rap',
  songs: 'One by A, Two by B and Three by C',
  count: '15',
};

/** PCM of a known length. Contents do not matter; the renderer only joins buffers. */
function clip(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * PCM_BYTES_PER_SEC));
}

function book(): BreakBook {
  return {
    version: 1,
    ids: ['ID one from {server}', 'ID two'],
    promos: ['Promo A', 'Promo B', 'Promo C', 'Promo D'],
    recap: ['That was {lastGenre} with {artists}.'],
    comingUp: ['Next is {genre}: {songs}. {count} songs.'],
    outro: ['Outro for {genre}'],
  };
}

/** Always picks the first line still allowed, so the order is fixed. */
const first = (): number => 0;

function files(parts: {
  id?: Buffer | null;
  sweeper?: Buffer | null;
  back?: Buffer | null;
  genre?: Buffer | null;
}): BreakFiles {
  return {
    id: async () => parts.id ?? null,
    sweeper: async () => parts.sweeper ?? null,
    back: async () => parts.back ?? null,
    genre: async () => parts.genre ?? null,
  };
}

function voices(
  seconds: number,
  fail: (voice: 'jingle' | 'dj', text: string) => boolean = () => false,
): { said: { voice: string; text: string; budget: number }[]; voices: BreakVoices } {
  const said: { voice: string; text: string; budget: number }[] = [];
  const speak =
    (voice: 'jingle' | 'dj'): BreakSpeak =>
    async (text, budget) => {
      said.push({ voice, text, budget });
      if (fail(voice, text)) throw new Error(`${voice} missed`);
      return clip(seconds);
    };
  return { said, voices: { jingle: speak('jingle'), dj: speak('dj') } };
}

describe('break book', () => {
  it('loads the English file and every template fills', () => {
    const loaded = loadBreakBook();
    assert.ok(loaded);
    for (const part of BREAK_PARTS) {
      assert.ok(loaded[part].length > 0, part);
      for (const template of loaded[part]) {
        const filled = fillBreak(template, FULL);
        assert.equal(/\{[a-z]+\}/.test(filled), false, template);
        assert.equal(filled.includes('{'), false, template);
      }
    }
    assert.match(loaded.ids[0] ?? '', /You're listening to Kitchen FM/);
    assert.match(loaded.promos.join('\n'), /Every fifteen songs, Kitchen FM changes the menu/);
  });
});

describe('station chime', () => {
  it('is a short loud bell that never clips', () => {
    const chime = stationChime();
    assert.equal(chime.length, Math.round(CHIME_SECONDS * 48_000) * 4);
    assert.equal(pcmSeconds(chime), CHIME_SECONDS);
    assert.ok(pcmLoudness(chime) > -50, String(pcmLoudness(chime)));

    let peak = 0;
    for (let i = 0; i < chime.length; i += 4) {
      const left = chime.readInt16LE(i);
      const right = chime.readInt16LE(i + 2);
      assert.equal(left, right);
      assert.ok(left > -32_768 && left < 32_767);
      peak = Math.max(peak, Math.abs(left));
    }
    const db = 20 * Math.log10(peak / 32_767);
    assert.ok(db > -7 && db < -5, String(db));
    // The last moment fades out, so the clip does not end on a click.
    assert.ok(Math.abs(chime.readInt16LE(chime.length - 4)) < peak / 20);

    const gap = breakGap();
    assert.equal(gap.length, Math.round(BREAK_GAP_SECONDS * 48_000) * 4);
    assert.equal(pcmLoudness(gap), Number.NEGATIVE_INFINITY);
  });
});

describe('intro wait', () => {
  it('follows a long clip and keeps a minute for a short one', () => {
    assert.equal(introPlayMs(null), INTRO_MIN_MS);
    assert.equal(introPlayMs(Buffer.alloc(0)), INTRO_MIN_MS);
    assert.equal(introPlayMs(clip(10)), INTRO_MIN_MS);
    assert.equal(introPlayMs(clip(50)), 50_000 + INTRO_MARGIN_MS);
    assert.equal(introPlayMs(clip(180)), 180_000 + INTRO_MARGIN_MS);
  });

  it('opens an unprefetched song late only when the intro is long', () => {
    assert.equal(streamOpenDelayMs(12, false), 0);
    assert.equal(streamOpenDelayMs(LONG_INTRO_SEC, false), 0);
    assert.equal(streamOpenDelayMs(180, true), 0);
    assert.equal(streamOpenDelayMs(Number.NaN, false), 0);
    assert.equal(streamOpenDelayMs(180, false), (180 - STREAM_LEAD_SEC) * 1000);
    assert.equal(streamOpenDelayMs(45.4, false), 30_400);
  });
});

describe('radio break', () => {
  const headSlots = { server: FULL.server, lastGenre: FULL.lastGenre, artists: FULL.artists };
  const tailSlots = { genre: FULL.genre, songs: FULL.songs, count: FULL.count };

  it('runs chime, ID, recap, then promos and IDs, and stops near the target', async () => {
    const spoken = voices(3);
    const used: BreakUsed = { ids: new Set(), promos: new Set() };
    const head = await renderBreakHead(book(), headSlots, spoken.voices, used, 40, first, 20);
    assert.deepEqual(head.roles, ['chime', 'id', 'recap', 'promo', 'promo', 'chime', 'id']);
    assert.equal(head.voiced, true);
    assert.ok(Math.abs(head.seconds - 20.4) < 0.02, String(head.seconds));
    assert.ok(head.seconds < 40);

    const tail = await renderBreakTail(book(), tailSlots, spoken.voices, first);
    assert.deepEqual(tail.roles, ['comingUp', 'chime', 'outro']);

    const whole = joinBreak(head, tail);
    assert.deepEqual(whole.roles, [...head.roles, ...tail.roles]);
    assert.equal(whole.voiced, true);
    assert.deepEqual(
      spoken.said.map((part) => `${part.voice}: ${part.text}`),
      [
        'jingle: ID one from Kitchen',
        'dj: That was rock with A, B and C.',
        'jingle: Promo A',
        'jingle: Promo B',
        'jingle: ID two',
        'dj: Next is rap: One by A, Two by B and Three by C. 15 songs.',
        'jingle: Outro for rap',
      ],
    );
    assert.ok(spoken.said.every((part) => part.budget === BREAK_SPEAK_MS));
    const promos = spoken.said
      .filter((part) => part.text.startsWith('Promo'))
      .map((part) => part.text);
    assert.equal(new Set(promos).size, promos.length);
  });

  it('does not repeat a promo or an ID inside one break', async () => {
    const lines = book();
    lines.ids = ['Only ID'];
    lines.promos = ['Only promo'];
    const spoken = voices(1);
    const used: BreakUsed = { ids: new Set(), promos: new Set() };
    const head = await renderBreakHead(lines, headSlots, spoken.voices, used, 120, first, 0);
    const ids = head.roles.filter((role) => role === 'id');
    const promos = head.roles.filter((role) => role === 'promo');
    assert.deepEqual(ids, ['id']);
    assert.deepEqual(promos, ['promo']);
    assert.equal(spoken.said.filter((part) => part.text === 'Only ID').length, 1);
    assert.equal(spoken.said.filter((part) => part.text === 'Only promo').length, 1);
  });

  it('prefers a line this show has not used yet', () => {
    const showUsed = new Set([0]);
    const picked = takeBreakLine(['Promo A', 'Promo B', 'Promo C'], showUsed, new Set(), first);
    assert.equal(picked, 1);
    assert.ok(showUsed.has(1));
  });

  it('leaves out a part whose voice fails, and keeps the rest', async () => {
    const spoken = voices(2, (voice, text) => voice === 'jingle' && text.startsWith('ID one'));
    const head = await renderBreakHead(
      book(),
      headSlots,
      spoken.voices,
      { ids: new Set(), promos: new Set() },
      40,
      first,
      20,
    );
    assert.deepEqual(head.roles.slice(0, 2), ['chime', 'recap']);
    assert.equal(head.roles.filter((role) => role === 'id').length, 1);
    assert.equal(head.voiced, true);
    assert.equal(
      spoken.said.some((part) => part.text.startsWith('ID one')),
      true,
    );

    const silent = voices(2, () => true);
    const missed = await renderBreakHead(
      book(),
      headSlots,
      silent.voices,
      { ids: new Set(), promos: new Set() },
      30,
      first,
      20,
    );
    assert.equal(missed.voiced, false);
    assert.equal(missed.pcm, null);
    const tail = await renderBreakTail(book(), tailSlots, silent.voices, first);
    assert.equal(joinBreak(missed, tail).voiced, false);
  });

  it('makes nothing when the break length is 0', async () => {
    const spoken = voices(3);
    const clipBreak = await renderBreakHead(
      book(),
      headSlots,
      spoken.voices,
      { ids: new Set(), promos: new Set() },
      0,
      first,
    );
    assert.deepEqual(clipBreak, emptyBreak());
    assert.equal(spoken.said.length, 0);
  });

  it('plays jingle files in order, and a missing genre keeps the spoken outro', async () => {
    const id = clip(1);
    const sweeper = clip(1);
    const back = clip(1);
    const genre = clip(1);
    const spoken = voices(3);
    const used: BreakUsed = { ids: new Set(), promos: new Set() };
    const head = await renderBreakHead(
      book(),
      headSlots,
      spoken.voices,
      used,
      40,
      first,
      20,
      files({ id, sweeper, back, genre }),
    );
    assert.deepEqual(head.roles, [
      'idFile',
      'recap',
      'promo',
      'sweeper',
      'promo',
      'idFile',
      'promo',
      'sweeper',
      'promo',
    ]);
    assert.equal(head.voiced, true);
    assert.equal(used.ids.size, 0);
    assert.equal(head.ranges[0]?.spoken, false);
    assert.equal(
      head.ranges.some((range) => range.spoken),
      true,
    );

    const tail = await renderBreakTail(
      book(),
      tailSlots,
      spoken.voices,
      first,
      files({ id, sweeper, back, genre }),
    );
    assert.deepEqual(tail.roles, ['comingUp', 'back', 'genre']);
    assert.equal(joinBreak(head, tail).voiced, true);
    assert.deepEqual(
      spoken.said.map((part) => part.text),
      [
        'That was rock with A, B and C.',
        'Promo A',
        'Promo B',
        'Promo C',
        'Promo D',
        'Next is rap: One by A, Two by B and Three by C. 15 songs.',
      ],
    );
    assert.equal(
      spoken.said.some((part) => part.text.startsWith('ID') || part.text.startsWith('Outro')),
      false,
    );

    const withoutGenre = voices(3);
    const genreMissing = await renderBreakTail(
      book(),
      tailSlots,
      withoutGenre.voices,
      first,
      files({ back, genre: null }),
    );
    assert.deepEqual(genreMissing.roles, ['comingUp', 'back', 'chime', 'outro']);
    assert.equal(
      withoutGenre.said.some((part) => part.text.startsWith('Outro')),
      true,
    );
  });

  it('matches today’s break when every jingle file is missing', async () => {
    const plainSpoken = voices(3);
    const plainUsed: BreakUsed = { ids: new Set(), promos: new Set() };
    const plainHead = await renderBreakHead(
      book(),
      headSlots,
      plainSpoken.voices,
      plainUsed,
      40,
      first,
      20,
    );
    const plainTail = await renderBreakTail(book(), tailSlots, plainSpoken.voices, first);

    const missedSpoken = voices(3);
    const missedHead = await renderBreakHead(
      book(),
      headSlots,
      missedSpoken.voices,
      { ids: new Set(), promos: new Set() },
      40,
      first,
      20,
      files({}),
    );
    const missedTail = await renderBreakTail(
      book(),
      tailSlots,
      missedSpoken.voices,
      first,
      files({}),
    );
    assert.deepEqual(missedHead.roles, plainHead.roles);
    assert.deepEqual(missedTail.roles, plainTail.roles);
    assert.equal(missedHead.seconds, plainHead.seconds);
    assert.equal(missedTail.seconds, plainTail.seconds);
    assert.ok(missedHead.pcm?.equals(plainHead.pcm ?? Buffer.alloc(0)));
    assert.ok(missedTail.pcm?.equals(plainTail.pcm ?? Buffer.alloc(0)));
    assert.deepEqual(missedHead.ranges, plainHead.ranges);
    assert.deepEqual(
      missedSpoken.said.map((part) => part.text),
      plainSpoken.said.map((part) => part.text),
    );
    assert.deepEqual(missedHead.roles, ['chime', 'id', 'recap', 'promo', 'promo', 'chime', 'id']);
    assert.deepEqual(missedTail.roles, ['comingUp', 'chime', 'outro']);
  });

  it('ducks the bed under a jingle file and keeps it under the recap', async () => {
    const id = clip(0.5);
    for (let i = 0; i < id.length; i += 4) {
      id.writeInt16LE(1_500, i);
      id.writeInt16LE(1_500, i + 2);
    }
    const spoken = voices(1);
    const head = await renderBreakHead(
      book(),
      headSlots,
      spoken.voices,
      { ids: new Set(), promos: new Set() },
      1,
      first,
      BREAK_TAIL_SEC,
      files({ id }),
    );
    assert.deepEqual(head.roles, ['idFile', 'recap']);
    const bed = clip(2);
    for (let i = 0; i < bed.length; i += 4) {
      bed.writeInt16LE(18_000, i);
      bed.writeInt16LE(18_000, i + 2);
    }
    const laid = applyBed(head, bed);
    assert.ok(laid.pcm);
    assert.ok(laid.pcm.subarray(0, id.length).equals(id));
    // The gap before the recap is spoken too, and the bed is still fading there.
    const recap = head.ranges.filter((range) => range.spoken).at(-1);
    assert.ok(recap);
    const db = pcmLoudness(laid.pcm.subarray(recap.startByte, recap.endByte));
    assert.ok(Math.abs(db - BED_TARGET_DB) < 1, String(db));
    assert.equal(applyBed(head, null), head);
  });

  it('leaves the tail allowance at 20 seconds until the files are known', () => {
    assert.equal(breakTailReserve(), BREAK_TAIL_SEC);
    assert.equal(breakTailReserve(7.4, 0), 27.4);
    assert.equal(breakTailReserve(0, 10), 22);
    assert.equal(breakTailReserve(7.4, 10), 29.4);
    assert.equal(breakTailReserve(Number.NaN, Number.NaN), BREAK_TAIL_SEC);
  });
});
