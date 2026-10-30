import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BED_FADE_SEC,
  BED_TARGET_DB,
  JINGLE_CACHE_BYTES,
  JINGLE_PEAK_DB,
  JINGLE_RESCAN_MS,
  JINGLE_TARGET_DB,
  JingleLibrary,
  classifyJingleName,
  jinglesDir,
  mixBed,
  mixBedAsync,
  normalizePcm,
  pcmPeak,
  pickJingle,
  playNewFindJingle,
  readJingleNames,
  storeClip,
  type JingleFile,
  type PcmCache,
} from '../src/fm/jingles';
import { pcmLoudness } from '../src/fm/voice';

const RATE = 48_000;
const FRAME = 4;

/** Stereo s16le. Both channels hold `sample`. */
function constant(frames: number, sample: number): Buffer {
  const out = Buffer.alloc(frames * FRAME);
  for (let i = 0; i < frames; i += 1) {
    out.writeInt16LE(sample, i * FRAME);
    out.writeInt16LE(sample, i * FRAME + 2);
  }
  return out;
}

function tone(frames: number, hz: number, amp: number): Buffer {
  const out = Buffer.alloc(frames * FRAME);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE));
    out.writeInt16LE(sample, i * FRAME);
    out.writeInt16LE(sample, i * FRAME + 2);
  }
  return out;
}

function maxStep(pcm: Buffer): number {
  let step = 0;
  const frames = Math.floor(pcm.length / FRAME);
  for (let i = 1; i < frames; i += 1) {
    const delta = Math.abs(pcm.readInt16LE(i * FRAME) - pcm.readInt16LE((i - 1) * FRAME));
    if (delta > step) step = delta;
  }
  return step;
}

function file(kind: JingleFile['kind'], id: string): JingleFile {
  return { kind, id, file: `mem://${kind}-${id}` };
}

describe('jingle names', () => {
  it('classifies the folder by file name', () => {
    assert.deepEqual(classifyJingleName('genre-rock.mp3'), { kind: 'genre', id: 'rock' });
    assert.deepEqual(classifyJingleName('GENRE-CZ-RAP.WAV'), { kind: 'genre', id: 'cz-rap' });
    assert.equal(classifyJingleName('genre-jazz.mp3'), null);
    assert.equal(classifyJingleName('genre-.mp3'), null);
    assert.deepEqual(classifyJingleName('ID-MAIN.MP3'), { kind: 'id', id: 'main' });
    assert.deepEqual(classifyJingleName('folder/id-foo.wav'), { kind: 'id', id: 'foo' });
    assert.deepEqual(classifyJingleName('sweeper-5.mp3'), { kind: 'sweeper', id: '5' });
    assert.deepEqual(classifyJingleName('bed-4.wav'), { kind: 'bed', id: '4' });
    assert.equal(classifyJingleName('id-.mp3'), null);
    assert.equal(classifyJingleName('sweeper.mp3'), null);
    assert.deepEqual(classifyJingleName('dedication.mp3'), {
      kind: 'dedication',
      id: 'dedication',
    });
    assert.deepEqual(classifyJingleName('new-find.wav'), { kind: 'new-find', id: 'new-find' });
    assert.deepEqual(classifyJingleName('back-to-music.mp3'), {
      kind: 'back-to-music',
      id: 'back-to-music',
    });
    assert.equal(classifyJingleName('notes.txt'), null);
    assert.deepEqual(classifyJingleName('C:\\assets\\id-main.mp3'), { kind: 'id', id: 'main' });
  });

  it('reads the folder and ignores anything else', () => {
    assert.equal(jinglesDir().replace(/\\/g, '/').endsWith('assets/fm/jingles'), true);
    const dir = mkdtempSync(join(tmpdir(), 'fm-jingles-'));
    try {
      writeFileSync(join(dir, 'genre-rock.mp3'), Buffer.alloc(0));
      writeFileSync(join(dir, 'id-main.wav'), Buffer.alloc(0));
      writeFileSync(join(dir, 'notes.txt'), Buffer.alloc(0));
      const names = readJingleNames(dir)
        .map((item) => `${item.kind}:${item.id}`)
        .sort();
      assert.deepEqual(names, ['genre:rock', 'id:main']);
      assert.deepEqual(readJingleNames(join(dir, 'missing')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('jingle picks', () => {
  const files = [file('id', 'main'), file('id', 'jazz'), file('sweeper', '1'), file('bed', '1')];

  it('prefers one this show has not used, then any of them', () => {
    const used = new Set<string>();
    assert.equal(pickJingle(files, 'id', used, () => 0)?.id, 'main');
    assert.equal(pickJingle(files, 'id', used, () => 0)?.id, 'jazz');
    assert.ok(used.has('main') && used.has('jazz'));
    assert.equal(pickJingle(files, 'id', used, () => 0.99)?.id, 'jazz');
    assert.equal(pickJingle(files, 'id', used, () => 1)?.id, 'jazz');
    assert.equal(pickJingle(files, 'bed', new Set(), () => 0)?.id, '1');
    assert.equal(pickJingle(files, 'sweeper', new Set(['1']), () => 0)?.id, '1');
    assert.equal(
      pickJingle([], 'id', used, () => 0),
      null,
    );
  });

  it('plays a new-find jingle once, and not on the block’s first set', () => {
    const yes = {
      how: 'new',
      opener: false,
      blockStart: false,
      played: false,
      rotation: true,
    };
    assert.equal(playNewFindJingle(yes), true);
    assert.equal(playNewFindJingle({ ...yes, opener: true }), false);
    assert.equal(playNewFindJingle({ ...yes, blockStart: true }), false);
    assert.equal(playNewFindJingle({ ...yes, played: true }), false);
    assert.equal(playNewFindJingle({ ...yes, how: 'play' }), false);
    assert.equal(playNewFindJingle({ ...yes, rotation: false }), false);
  });
});

describe('jingle loudness', () => {
  it('brings a jingle to about -20 dBFS and holds the peak under -1', () => {
    assert.equal(JINGLE_TARGET_DB, -20);
    assert.equal(JINGLE_PEAK_DB, -1);
    const square = constant(1000, 16_000);
    const out = normalizePcm(square, JINGLE_TARGET_DB);
    const db = pcmLoudness(out);
    assert.ok(Math.abs(db - JINGLE_TARGET_DB) < 0.05, String(db));
    const peakDb = 20 * Math.log10(pcmPeak(out) / 32_768);
    assert.ok(peakDb < JINGLE_PEAK_DB, String(peakDb));

    const quiet = Buffer.alloc(RATE * 2);
    quiet.writeInt16LE(32_767, 0);
    const capped = normalizePcm(quiet, JINGLE_TARGET_DB);
    const cappedDb = 20 * Math.log10(pcmPeak(capped) / 32_768);
    assert.ok(cappedDb < -1 && cappedDb > -1.05, String(cappedDb));
    assert.ok(pcmLoudness(capped) < -30, String(pcmLoudness(capped)));

    const silent = Buffer.alloc(8);
    assert.equal(pcmLoudness(normalizePcm(silent, JINGLE_TARGET_DB)), Number.NEGATIVE_INFINITY);
  });

  it('keeps a small cache and drops the oldest clip', () => {
    const cache: PcmCache = { bytes: new Map(), total: 0 };
    assert.equal(storeClip(cache, 'a', Buffer.alloc(10), 20), 10);
    assert.equal(storeClip(cache, 'b', Buffer.alloc(10), 20), 20);
    assert.equal(storeClip(cache, 'c', Buffer.alloc(10), 20), 20);
    assert.equal(cache.bytes.has('a'), false);
    assert.equal(storeClip(cache, 'b', Buffer.alloc(8), 20), 18);
    assert.equal(cache.bytes.get('b')?.length, 8);
    assert.equal(storeClip(cache, 'huge', Buffer.alloc(100), 20), 18);
    assert.equal(cache.bytes.has('huge'), false);
    assert.equal(storeClip(cache, 'empty', Buffer.alloc(0), 20), 18);
    assert.equal(JINGLE_CACHE_BYTES, 24 * 1024 * 1024);
  });
});

describe('jingle library', () => {
  it('rescans at most once a minute and caches a short clip', async () => {
    let now = 0;
    let scans = 0;
    let decodes = 0;
    const listing = [file('id', 'main')];
    const lib = new JingleLibrary({
      now: () => now,
      list: () => {
        scans += 1;
        return listing;
      },
      decode: async () => {
        decodes += 1;
        return constant(200, 8_000);
      },
    });
    assert.equal(lib.files().length, 1);
    assert.equal(lib.files().length, 1);
    now = JINGLE_RESCAN_MS - 1;
    lib.files();
    assert.equal(scans, 1);
    now = JINGLE_RESCAN_MS;
    lib.files();
    assert.equal(scans, 2);

    const first = await lib.clip(listing[0] ?? null);
    const second = await lib.clip(listing[0] ?? null);
    assert.equal(decodes, 1);
    assert.equal(first, second);
    assert.ok(first);
    assert.ok(Math.abs(pcmLoudness(first) - JINGLE_TARGET_DB) < 0.1);
  });

  it('decodes a bed for the seconds asked and does not cache it', async () => {
    const limits: (number | undefined)[] = [];
    const lib = new JingleLibrary({
      list: () => [file('bed', '1')],
      decode: async (_file, maxSec) => {
        limits.push(maxSec);
        return constant(100, 1_000);
      },
    });
    const bed = file('bed', '1');
    assert.ok(await lib.bed(bed, 2.5));
    assert.ok(await lib.bed(bed, 2.5));
    assert.deepEqual(limits, [2.5, 2.5]);
  });

  it('warns once when a file will not decode', async () => {
    const warns: string[] = [];
    const main = { kind: 'id' as const, id: 'main', file: 'mem://id-main.mp3' };
    const lib = new JingleLibrary({
      list: () => [main],
      decode: async () => {
        throw new Error('no ffmpeg');
      },
      warn: (message) => warns.push(message),
    });
    assert.equal(await lib.clip(main), null);
    assert.equal(await lib.clip(main), null);
    assert.deepEqual(warns, ['Kitchen FM jingle: could not play id-main.mp3.']);
  });
});

describe('music bed', () => {
  it('is silent under a jingle, at level under speech, and never clicks or clips', () => {
    assert.equal(BED_TARGET_DB, -34);
    assert.equal(BED_FADE_SEC, 0.4);
    const jingleFrames = Math.round(0.25 * RATE);
    const total = RATE;
    const voice = Buffer.alloc(total * FRAME);
    const mark = 2_222;
    for (let i = 0; i < jingleFrames; i += 1) {
      voice.writeInt16LE(mark, i * FRAME);
      voice.writeInt16LE(mark, i * FRAME + 2);
    }
    const ranges = [
      { startByte: 0, endByte: jingleFrames * FRAME, spoken: false },
      { startByte: jingleFrames * FRAME, endByte: voice.length, spoken: true },
    ];
    const mixed = mixBed(voice, ranges, constant(total, 18_000));
    assert.ok(
      mixed.subarray(0, jingleFrames * FRAME).equals(voice.subarray(0, jingleFrames * FRAME)),
    );

    const fadeFrames = Math.round(BED_FADE_SEC * RATE);
    const levelStart = (jingleFrames + fadeFrames) * FRAME;
    const level = mixed.subarray(levelStart, levelStart + Math.round(0.2 * RATE) * FRAME);
    const db = pcmLoudness(level);
    assert.ok(Math.abs(db - BED_TARGET_DB) < 0.5, String(db));

    const quiet = mixBed(Buffer.alloc(total * FRAME), ranges, constant(total, 18_000));
    assert.ok(maxStep(quiet) <= 1, String(maxStep(quiet)));
    assert.equal(quiet.readInt16LE(0), 0);
    assert.ok(Math.abs(quiet.readInt16LE(levelStart)) > 400);

    const hot = mixBed(
      constant(1000, 32_700),
      [{ startByte: 0, endByte: 1000 * FRAME, spoken: true }],
      constant(1000, 32_767),
    );
    assert.equal(hot.readInt16LE(0), 32_767);
    const cold = mixBed(
      constant(1000, -32_700),
      [{ startByte: 0, endByte: 1000 * FRAME, spoken: true }],
      constant(1000, -32_767),
    );
    assert.equal(cold.readInt16LE(0), -32_768);

    const silentBed = Buffer.alloc(FRAME * 10);
    const dry = constant(10, 1_000);
    assert.equal(mixBed(dry, [], silentBed), dry);
  });

  it('mixes in chunks to the same bytes, and lets other work run between chunks', async () => {
    // Longer than one chunk (2 s), with a jingle range in the middle and a loop.
    const total = RATE * 5;
    const voice = tone(total, 211, 3_000);
    const bed = tone(RATE * 3, 97, 9_000);
    const ranges = [
      { startByte: 0, endByte: RATE * 2 * FRAME, spoken: true },
      { startByte: RATE * 2 * FRAME, endByte: RATE * 3 * FRAME, spoken: false },
      { startByte: RATE * 3 * FRAME, endByte: total * FRAME, spoken: true },
    ];
    let turns = 0;
    const ticker = setInterval(() => {
      turns += 1;
    }, 0);
    const chunked = await mixBedAsync(voice, ranges, bed);
    clearInterval(ticker);
    assert.ok(chunked.equals(mixBed(voice, ranges, bed)));
    assert.ok(turns > 0, 'the event loop never got a turn');
    const silentBed = Buffer.alloc(FRAME * 10);
    assert.equal(await mixBedAsync(voice, ranges, silentBed), voice);
  });

  it('loops a short bed with a crossfade instead of a hard wrap', () => {
    // Not a whole number of cycles, so a hard wrap would jump. Long enough for a 1 s crossfade.
    const bedFrames = RATE * 2 + 5_000;
    const bed = tone(bedFrames, 137, 8_000);
    const voice = Buffer.alloc((bedFrames + Math.round(0.5 * RATE)) * FRAME);
    const mixed = mixBed(voice, [], bed);
    const level = normalizePcm(bed, BED_TARGET_DB);
    assert.equal(mixed.readInt16LE(0), level.readInt16LE(0));
    assert.equal(mixed.readInt16LE(2), level.readInt16LE(2));
    const wrap = Math.abs(level.readInt16LE((bedFrames - 1) * FRAME) - level.readInt16LE(0));
    assert.ok(wrap > 200, String(wrap));
    assert.ok(maxStep(mixed) < 40, String(maxStep(mixed)));
  });
});
