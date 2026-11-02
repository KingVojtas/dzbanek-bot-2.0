import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockSongCount, breakLength } from '../src/fm/station-breaks';

describe('block song count', () => {
  it('defaults to 15 songs when the show does not name one', () => {
    assert.equal(blockSongCount(undefined), 15);
    assert.equal(blockSongCount(Number.NaN), 15);
  });

  it('clamps a rotation block to 5–30 songs', () => {
    assert.equal(blockSongCount(1), 5);
    assert.equal(blockSongCount(4.6), 5);
    assert.equal(blockSongCount(15), 15);
    assert.equal(blockSongCount(22.4), 22);
    assert.equal(blockSongCount(80), 30);
  });
});

describe('break length', () => {
  it('defaults to three minutes when the show does not name one', () => {
    assert.equal(breakLength(undefined), 180);
    assert.equal(breakLength(Number.POSITIVE_INFINITY), 180);
  });

  it('keeps zero, which is the usual block line instead of a break', () => {
    assert.equal(breakLength(0), 0);
  });

  it('clamps a break to five minutes', () => {
    assert.equal(breakLength(-4), 0);
    assert.equal(breakLength(90.2), 90);
    assert.equal(breakLength(300), 300);
    assert.equal(breakLength(600), 300);
  });
});
