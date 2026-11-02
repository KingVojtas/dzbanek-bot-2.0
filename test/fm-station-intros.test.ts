import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '../src/core/logger';
import type { Track } from '../src/core/types';
import { DedicationQueue, joinClips, type WaitingDedication } from '../src/fm/dedications';
import { JINGLE_GAP_MS, type JingleLibrary } from '../src/fm/jingles';
import { templateOpener, type OpenerSong } from '../src/fm/script';
import { StationIntros } from '../src/fm/station-intros';
import type { FmSet } from '../src/fm/station-types';
import type { DjSpeaker } from '../src/fm/voice';

const logger = { warn() {}, info() {}, debug() {}, error() {} } as unknown as Logger;

function track(title: string): Track {
  return { title, url: `https://youtu.be/${title}`, durationSec: 180, requestedBy: 'Kitchen FM' };
}

function intros(options: {
  voice?: DjSpeaker;
  jingles?: JingleLibrary | null;
  about?: (song: Track) => OpenerSong | undefined;
  lines?: null;
  dedications?: DedicationQueue;
  dedicationOf?: WeakMap<Track, WaitingDedication>;
  ended?: () => boolean;
  sets?: WeakMap<Track, FmSet>;
}): { lines: StationIntros; sets: WeakMap<Track, FmSet> } {
  const sets = options.sets ?? new WeakMap<Track, FmSet>();
  const lines = new StationIntros({
    guildName: 'Kitchen',
    language: 'en',
    voice: options.voice ?? { speak: async () => Buffer.from([1, 0]) },
    jingles: options.jingles,
    logger,
    lines: options.lines,
    ended: options.ended ?? (() => false),
    setOf: (song) => sets.get(song),
    about: options.about ?? (() => undefined),
    dedications: options.dedications ?? new DedicationQueue(),
    dedicationOf: options.dedicationOf ?? new WeakMap(),
  });
  return { lines, sets };
}

describe('StationIntros lines', () => {
  it('fills the spoken slots from the clock, the song, and who just arrived', () => {
    const { lines } = intros({ lines: null });
    assert.deepEqual(
      lines.slots({ hour: 18, minute: 4, set: 2, newcomers: ['Ana', 'Ben'] }, 'Czech rap', {
        artist: 'Nova',
        title: 'Lavazza (official)',
        by: 'Vojta',
        how: 'play',
      }),
      {
        server: 'Kitchen',
        time: '6:04 PM',
        daypart: 'evening',
        genre: 'Czech rap',
        song: 'Lavazza by Nova',
        artist: 'Nova',
        by: 'Vojta',
        names: 'Ana and Ben',
        station: 'Kitchen FM',
        from: '',
        to: '',
        message: '',
      },
    );
  });

  it('uses the built-in opener when the line book is missing', () => {
    const { lines } = intros({ lines: null });
    const first = track('Lavazza');
    const base = { hour: 18, minute: 0, set: 1, newcomers: [] as string[] };
    const about = { artist: 'Nova', title: 'Lavazza', by: null, how: 'play' as const };
    assert.equal(
      lines.speak(base, 'Czech rap', first, false),
      templateOpener({
        language: 'en',
        server: 'Kitchen',
        ...base,
        vibe: 'Czech rap',
        first: { artist: '', title: first.title, by: null, how: 'play' },
      }),
    );
    // The song's own names are used when the station has them.
    const known = intros({ lines: null, about: () => about });
    assert.equal(
      known.lines.speak(base, 'Czech rap', first, false),
      templateOpener({
        language: 'en',
        server: 'Kitchen',
        ...base,
        vibe: 'Czech rap',
        first: about,
      }),
    );
  });
});

describe('StationIntros clips', () => {
  it('synthesizes one set line once, and puts the new-find jingle in front only the first time', async () => {
    const lead = Buffer.from([9, 9]);
    const prepared = Buffer.from([1, 2, 3, 4]);
    let clips = 0;
    const jingles = {
      files: () => [{ kind: 'new-find' as const, id: 'new-find', file: 'mem://new-find.mp3' }],
      clip: async () => {
        clips += 1;
        return lead;
      },
    } as unknown as JingleLibrary;
    const { lines, sets } = intros({
      jingles,
      about: () => ({ artist: 'Nova', title: 'Lavazza', by: null, how: 'new' }),
    });
    const first = track('one');
    const second = track('two');
    const setOf = (song: Track, line: string): FmSet => ({
      vibe: 'Czech rap',
      line,
      tracks: [song],
      next: 0,
      plannedAt: 0,
      opener: false,
      blockStart: false,
      rotationGenre: 'cz-rap',
      preparedClip: prepared,
    });
    const opening = setOf(first, 'First line');
    const later = setOf(second, 'Second line');
    sets.set(first, opening);
    sets.set(second, later);

    const asked = lines.setIntro(first);
    assert.equal(lines.setIntro(first), asked);
    const heard = await asked;
    assert.equal(heard?.text, 'First line');
    assert.deepEqual(heard?.pcm, joinClips([lead, prepared], JINGLE_GAP_MS));
    assert.equal(clips, 1);

    const again = await lines.setIntro(second);
    assert.equal(again?.text, 'Second line');
    assert.deepEqual(again?.pcm, prepared);
    assert.equal(clips, 1);
  });

  it('shares one dedication call, and tries again when the voice came back empty', async () => {
    const spoken = Buffer.from([4, 5]);
    const heard: Buffer[] = [Buffer.alloc(0), spoken];
    let calls = 0;
    const { lines } = intros({
      voice: {
        speak: async () => {
          calls += 1;
          return heard.shift() ?? null;
        },
      },
    });
    const dedication: WaitingDedication = {
      userId: 'u',
      from: 'Ana',
      to: '',
      message: 'hi',
      track: null,
      song: '',
      text: 'Ana sends this.',
      speech: Promise.resolve(null),
    };
    const first = lines.speakDedication(dedication);
    assert.equal(lines.speakDedication(dedication), first);
    // An empty clip comes back as it is; the cache entry is dropped so the next ask retries.
    assert.equal((await first)?.length, 0);
    assert.equal(calls, 1);
    assert.equal(await lines.speakDedication(dedication), spoken);
    assert.equal(calls, 2);
    assert.equal(dedication.speech, lines.dedicationClips.get(dedication));
  });

  it('binds the waiting dedication when the song starts, and not again', () => {
    const dedications = new DedicationQueue();
    const dedicationOf = new WeakMap<Track, WaitingDedication>();
    const song = track('Lavazza');
    const dedication: WaitingDedication = {
      userId: 'u',
      from: 'Ana',
      to: '',
      message: 'hi',
      track: null,
      song: '',
      text: 'hi',
      speech: Promise.resolve(null),
    };
    dedications.add(dedication);
    const { lines } = intros({ dedications, dedicationOf });
    lines.handDedication(song);
    lines.handDedication(song);
    assert.equal(dedicationOf.get(song), dedication);
    assert.equal(dedications.length, 0);
  });
});
