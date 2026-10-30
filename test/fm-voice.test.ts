import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DjVoice,
  firstAudio,
  HEDGE_MS,
  MAX_ATTEMPTS,
  pcmLoudness,
  RETRY_PAUSE_MS,
  voiceTimingLine,
  type SynthesisAttempt,
} from '../src/fm/voice';

describe('pcmLoudness', () => {
  it('is negative infinity for silence', () => {
    assert.equal(pcmLoudness(Buffer.alloc(0)), Number.NEGATIVE_INFINITY);
    assert.equal(pcmLoudness(Buffer.alloc(4800)), Number.NEGATIVE_INFINITY);
  });

  it('reads a steady tone in dBFS', () => {
    const pcm = Buffer.alloc(4800);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(16_000, i);
    const db = pcmLoudness(pcm);
    assert.ok(db > -10 && db < -5, String(db));
  });

  it('calls a near-silent buffer quiet', () => {
    const pcm = Buffer.alloc(4800);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1, i);
    assert.ok(pcmLoudness(pcm) < -50);
  });
});

interface FakeAttempt extends SynthesisAttempt {
  markHeard(): void;
  giveAudio(bytes?: Buffer): void;
  fail(message: string): void;
  readonly closed: boolean;
  readonly failed: boolean;
}

/** A synthesis that does nothing until the test says so. No network. */
function fakeAttempt(): FakeAttempt {
  let resolveHeard: () => void = () => {};
  let rejectHeard: (error: Error) => void = () => {};
  let resolveAudio: (buffer: Buffer) => void = () => {};
  let rejectAudio: (error: Error) => void = () => {};
  const heard = new Promise<void>((resolve, reject) => {
    resolveHeard = resolve;
    rejectHeard = reject;
  });
  const audio = new Promise<Buffer>((resolve, reject) => {
    resolveAudio = resolve;
    rejectAudio = reject;
  });
  heard.catch(() => {});
  audio.catch(() => {});
  let closed = false;
  let didFail = false;
  return {
    heard,
    audio,
    get closed() {
      return closed;
    },
    get failed() {
      return didFail;
    },
    close() {
      if (closed) return;
      closed = true;
      rejectHeard(new Error('closed'));
      rejectAudio(new Error('closed'));
    },
    markHeard() {
      resolveHeard();
    },
    giveAudio(bytes = Buffer.from('mp3')) {
      resolveHeard();
      resolveAudio(bytes);
    },
    fail(message: string) {
      didFail = true;
      const error = new Error(message);
      rejectHeard(error);
      rejectAudio(error);
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** A clock the race can wait on. Time moves only when the test says so. */
function manualClock() {
  let time = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    now: () => time,
    wait(ms: number) {
      return new Promise<void>((resolve) => {
        waiters.push({ at: time + ms, resolve });
        waiters.sort((a, b) => a.at - b.at);
      });
    },
    async advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const next = waiters[0];
        if (!next || next.at > target) break;
        waiters.shift();
        time = next.at;
        next.resolve();
        await tick();
      }
      time = target;
    },
  };
}

function tone(): Buffer {
  const pcm = Buffer.alloc(4800);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8_000, i);
  return pcm;
}

function captureLog() {
  const lines: { level: string; message: string }[] = [];
  const logger = {
    debug(message: string) {
      lines.push({ level: 'debug', message });
    },
    info(message: string) {
      lines.push({ level: 'info', message });
    },
    warn(message: string) {
      lines.push({ level: 'warn', message });
    },
    error(message: string) {
      lines.push({ level: 'error', message });
    },
  };
  return { lines, logger };
}

describe('firstAudio', () => {
  it('uses the first attempt when it speaks, and does not start a second', async () => {
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        attempt.giveAudio(Buffer.from('one'));
        return attempt;
      },
      3_000,
      () => new Promise(() => {}),
    );
    const won = await pending;
    assert.equal(attempts.length, 1);
    assert.equal(won.attempt, 1);
    assert.equal(won.attempt1Note, null);
    assert.equal(won.buffer.toString(), 'one');
  });

  it('starts a second attempt when the first sends nothing, and closes the first', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(opener(attempts), HEDGE_MS, clock.wait, { now: clock.now });
    assert.equal(attempts.length, 1);
    await clock.advance(HEDGE_MS);
    assert.equal(attempts.length, 2);
    attempts[1]!.giveAudio(Buffer.from('two'));
    const won = await pending;
    assert.equal(won.attempt, 2);
    assert.equal(won.attempt1Note, 'no audio after 3 s');
    assert.equal(won.buffer.toString(), 'two');
    assert.equal(attempts[0]!.closed, true);
    assert.equal(attempts.length, 2);
  });

  it('starts the next attempt after a short pause when the first fails', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(opener(attempts), HEDGE_MS, clock.wait, { now: clock.now });
    attempts[0]!.fail('Stream closed before the synthesis completed');
    await tick();
    assert.equal(attempts.length, 1);
    await clock.advance(RETRY_PAUSE_MS);
    assert.equal(attempts.length, 2);
    attempts[1]!.giveAudio(Buffer.from('retry'));
    const won = await pending;
    assert.equal(won.attempt, 2);
    assert.equal(won.attempt1Note, 'Stream closed before the synthesis completed');
    assert.equal(attempts.length, 2);
  });

  it('does not hedge once the first attempt has sent audio', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(opener(attempts), HEDGE_MS, clock.wait, { now: clock.now });
    attempts[0]!.markHeard();
    await tick();
    await clock.advance(HEDGE_MS);
    assert.equal(attempts.length, 1);
    attempts[0]!.giveAudio(Buffer.from('late'));
    const won = await pending;
    assert.equal(won.attempt, 1);
    assert.equal(won.buffer.toString(), 'late');
  });

  it('keeps the first clip when it finishes after the hedge has started', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(opener(attempts), HEDGE_MS, clock.wait, { now: clock.now });
    await clock.advance(HEDGE_MS);
    assert.equal(attempts.length, 2);
    attempts[0]!.giveAudio(Buffer.from('first'));
    const won = await pending;
    assert.equal(won.attempt, 1);
    assert.equal(attempts[1]!.closed, true);
    assert.equal(won.buffer.toString(), 'first');
  });

  it('still waits for a slow first attempt when the hedge fails', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(opener(attempts), HEDGE_MS, clock.wait, { now: clock.now });
    await clock.advance(HEDGE_MS);
    attempts[1]!.fail('second down');
    await tick();
    assert.equal(attempts[0]!.closed, false);
    assert.equal(attempts.length, 2);
    attempts[0]!.giveAudio(Buffer.from('slow'));
    const won = await pending;
    assert.equal(won.attempt, 1);
    assert.equal(won.buffer.toString(), 'slow');
  });

  it('stops at the attempt cap', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(opener(attempts), HEDGE_MS, clock.wait, {
      now: clock.now,
      maxAttempts: 2,
      budgetMs: 60_000,
    });
    attempts[0]!.fail('first down');
    await tick();
    await clock.advance(RETRY_PAUSE_MS);
    attempts[1]!.fail('second down');
    await assert.rejects(pending, /second down/);
    assert.equal(attempts.length, 2);
  });
});

/** A race whose attempts wait until the test moves them. */
function opener(attempts: FakeAttempt[]): () => FakeAttempt {
  return () => {
    const attempt = fakeAttempt();
    attempts.push(attempt);
    return attempt;
  };
}

describe('voiceTimingLine', () => {
  it('names the attempt that spoke', () => {
    assert.equal(voiceTimingLine(1100, 1, null), 'Kitchen FM voice: Edge 1.1 s (attempt 1)');
    assert.equal(
      voiceTimingLine(4200, 2, 'no audio after 3 s'),
      'Kitchen FM voice: Edge 4.2 s (attempt 2; attempt 1: no audio after 3 s)',
    );
    assert.equal(
      voiceTimingLine(8400, 3, 'Stream closed'),
      'Kitchen FM voice: Edge 8.4 s (attempt 3; attempt 1: Stream closed)',
    );
  });
});

describe('DjVoice.speak', () => {
  const dropped = 'Stream closed before the synthesis completed';

  function voiceWith(clock: ReturnType<typeof manualClock>, attempts: FakeAttempt[]) {
    const log = captureLog();
    const voice = new DjVoice(
      'en-US-AndrewMultilingualNeural',
      log.logger as never,
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      { decode: async () => tone(), now: clock.now, wait: clock.wait },
    );
    return { voice, log };
  }

  it('speaks after two drops', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const { voice, log } = voiceWith(clock, attempts);
    const pending = voice.speak('Hello from the kitchen');
    await tick();
    attempts[0]!.fail(dropped);
    await tick();
    await clock.advance(RETRY_PAUSE_MS);
    attempts[1]!.fail(dropped);
    await tick();
    await clock.advance(RETRY_PAUSE_MS);
    attempts[2]!.giveAudio(Buffer.from('mp3'));
    const pcm = await pending;
    assert.ok(pcm && pcm.length > 0);
    assert.equal(attempts.length, 3);
    assert.equal(log.lines.filter((line) => line.level === 'warn').length, 0);
    assert.equal(
      log.lines.some((line) => line.message.includes('text only')),
      false,
    );
    assert.equal(
      log.lines.find((line) => line.message.startsWith('Kitchen FM voice: Edge'))?.message,
      voiceTimingLine(RETRY_PAUSE_MS * 2, 3, dropped),
    );
    const failures = log.lines.filter((line) => line.message.includes('failed after'));
    assert.equal(failures.length, 2);
    assert.match(failures[0]?.message ?? '', /attempt 1 failed after 0\.0 s/);
    assert.match(failures[1]?.message ?? '', /en-US-AndrewMultilingualNeural/);
    assert.match(failures[1]?.message ?? '', new RegExp(dropped));
  });

  it('gives null when the budget runs out', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const { voice, log } = voiceWith(clock, attempts);
    const pending = voice.speak('Hello from the kitchen', 5_000);
    await tick();
    await clock.advance(5_000);
    assert.equal(await pending, null);
    assert.equal(attempts.length, 2);
    assert.equal(
      log.lines.find((line) => line.message.includes('text only'))?.message,
      'Kitchen FM voice: text only: 2 attempts failed in 5.0 s, last: the time budget ran out',
    );
    assert.equal(log.lines.filter((line) => line.level === 'warn').length, 0);
  });

  it('keeps at most two attempts in flight', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const { voice } = voiceWith(clock, attempts);
    let liveMax = 0;
    const sample = () => {
      const live = attempts.filter((attempt) => !attempt.closed && !attempt.failed).length;
      liveMax = Math.max(liveMax, live);
    };
    const pending = voice.speak('Hello from the kitchen', 60_000);
    await tick();
    sample();
    await clock.advance(HEDGE_MS);
    sample();
    assert.equal(attempts.length, 2);
    attempts[0]!.fail('down');
    await tick();
    sample();
    await clock.advance(RETRY_PAUSE_MS);
    sample();
    assert.equal(attempts.length, 3);
    await clock.advance(HEDGE_MS);
    sample();
    assert.equal(
      attempts.filter((attempt) => !attempt.closed && !attempt.failed).length <= 2,
      true,
    );
    assert.equal(liveMax <= 2, true);
    const open = attempts.filter((attempt) => !attempt.closed && !attempt.failed);
    open[0]!.giveAudio(Buffer.from('mp3'));
    assert.ok(await pending);
  });

  it('counts a speak that used every attempt as one miss', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const { voice, log } = voiceWith(clock, attempts);
    for (let miss = 0; miss < 3; miss += 1) {
      const pending = voice.speak('Hello from the kitchen', 100);
      await tick();
      attempts.at(-1)!.fail('down');
      await tick();
      await clock.advance(100);
      assert.equal(await pending, null);
    }
    assert.equal(attempts.length, 3);
    assert.equal(
      log.lines.filter((line) => line.message.startsWith('Kitchen FM voice: text only:')).length,
      3,
    );
    assert.equal(log.lines.filter((line) => line.level === 'warn').length, 1);
    const before = attempts.length;
    assert.equal(await voice.speak('Hello from the kitchen'), null);
    assert.equal(attempts.length, before);
  });

  it('stops after the attempt cap', async () => {
    const clock = manualClock();
    const attempts: FakeAttempt[] = [];
    const { voice, log } = voiceWith(clock, attempts);
    const pending = voice.speak('Hello from the kitchen', 60_000);
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      await tick();
      assert.equal(attempts.length, n);
      attempts[n - 1]!.fail('down');
      await tick();
      if (n < MAX_ATTEMPTS) await clock.advance(RETRY_PAUSE_MS);
    }
    assert.equal(await pending, null);
    assert.equal(attempts.length, MAX_ATTEMPTS);
    assert.match(
      log.lines.find((line) => line.message.includes('text only'))?.message ?? '',
      new RegExp(`${MAX_ATTEMPTS} attempts failed`),
    );
    assert.equal(log.lines.filter((line) => line.level === 'warn').length, 0);
  });
});
