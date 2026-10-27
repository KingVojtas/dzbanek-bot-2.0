import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstAudio, pcmLoudness, voiceTimingLine, type SynthesisAttempt } from '../src/fm/voice';

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
  return {
    heard,
    audio,
    get closed() {
      return closed;
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
      const error = new Error(message);
      rejectHeard(error);
      rejectAudio(error);
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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
    const attempts: FakeAttempt[] = [];
    let release: () => void = () => {};
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      3_000,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    assert.equal(attempts.length, 1);
    release();
    await tick();
    assert.equal(attempts.length, 2);
    attempts[1]!.giveAudio(Buffer.from('two'));
    const won = await pending;
    assert.equal(won.attempt, 2);
    assert.equal(won.attempt1Note, 'no audio after 3 s');
    assert.equal(won.buffer.toString(), 'two');
    assert.equal(attempts[0]!.closed, true);
    assert.equal(attempts.length, 2);
  });

  it('starts the second attempt at once when the first fails', async () => {
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      3_000,
      () => new Promise(() => {}),
    );
    attempts[0]!.fail('Stream closed before the synthesis completed');
    await tick();
    assert.equal(attempts.length, 2);
    attempts[1]!.giveAudio(Buffer.from('retry'));
    const won = await pending;
    assert.equal(won.attempt, 2);
    assert.equal(won.attempt1Note, 'Stream closed before the synthesis completed');
    assert.equal(attempts.length, 2);
  });

  it('does not hedge once the first attempt has sent audio', async () => {
    const attempts: FakeAttempt[] = [];
    let release: () => void = () => {};
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      3_000,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    attempts[0]!.markHeard();
    await tick();
    release();
    await tick();
    assert.equal(attempts.length, 1);
    attempts[0]!.giveAudio(Buffer.from('late'));
    const won = await pending;
    assert.equal(won.attempt, 1);
    assert.equal(won.buffer.toString(), 'late');
  });

  it('keeps the first clip when it finishes after the hedge has started', async () => {
    const attempts: FakeAttempt[] = [];
    let release: () => void = () => {};
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      3_000,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    release();
    await tick();
    assert.equal(attempts.length, 2);
    attempts[0]!.giveAudio(Buffer.from('first'));
    const won = await pending;
    assert.equal(won.attempt, 1);
    assert.equal(attempts[1]!.closed, true);
    assert.equal(won.buffer.toString(), 'first');
  });

  it('still waits for a slow first attempt when the hedge fails', async () => {
    const attempts: FakeAttempt[] = [];
    let release: () => void = () => {};
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      3_000,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    release();
    await tick();
    attempts[1]!.fail('second down');
    await tick();
    assert.equal(attempts[0]!.closed, false);
    attempts[0]!.giveAudio(Buffer.from('slow'));
    const won = await pending;
    assert.equal(won.attempt, 1);
    assert.equal(won.buffer.toString(), 'slow');
  });

  it('rejects when both attempts fail, and never starts a third', async () => {
    const attempts: FakeAttempt[] = [];
    const pending = firstAudio(
      () => {
        const attempt = fakeAttempt();
        attempts.push(attempt);
        return attempt;
      },
      3_000,
      () => new Promise(() => {}),
    );
    attempts[0]!.fail('first down');
    await tick();
    attempts[0]!.fail('first down again');
    attempts[1]!.fail('second down');
    await assert.rejects(pending, /second down/);
    assert.equal(attempts.length, 2);
  });
});

describe('voiceTimingLine', () => {
  it('names the attempt that spoke', () => {
    assert.equal(voiceTimingLine(1100, 1, null), 'Kitchen FM voice: Edge 1.1 s (attempt 1)');
    assert.equal(
      voiceTimingLine(4200, 2, 'no audio after 3 s'),
      'Kitchen FM voice: Edge 4.2 s (attempt 2; attempt 1: no audio after 3 s)',
    );
  });
});
