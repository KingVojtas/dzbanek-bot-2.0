import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pcmLoudness } from '../src/fm/voice';

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
