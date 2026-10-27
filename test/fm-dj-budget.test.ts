import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DjBudget } from '../src/fm/writer';

const TZ = 'Europe/Prague';

/** A budget whose clock the test moves by hand. */
function budget(setsPerServerPerDay: number, setsPerDay: number) {
  let now = new Date('2026-10-27T10:00:00Z');
  const book = new DjBudget({ setsPerServerPerDay, setsPerDay, timezone: TZ }, () => now);
  return {
    book,
    at(iso: string) {
      now = new Date(iso);
    },
  };
}

describe('DjBudget', () => {
  it('stops a server at its own daily cap and leaves the others alone', () => {
    const { book } = budget(2, 10);
    assert.equal(book.take('a'), 'ok');
    assert.equal(book.take('a'), 'ok');
    assert.equal(book.take('a'), 'server');
    assert.equal(book.take('b'), 'ok');
  });

  it('stops every server once the whole bot hits its cap', () => {
    const { book } = budget(5, 3);
    assert.equal(book.take('a'), 'ok');
    assert.equal(book.take('b'), 'ok');
    assert.equal(book.take('c'), 'ok');
    assert.equal(book.take('d'), 'bot');
  });

  it('a refused set does not count', () => {
    const { book } = budget(1, 2);
    assert.equal(book.take('a'), 'ok');
    assert.equal(book.take('a'), 'server');
    assert.equal(book.take('b'), 'ok');
  });

  it('starts over at midnight in the kitchen timezone, not UTC', () => {
    const { book, at } = budget(1, 10);
    at('2026-10-27T22:30:00Z'); // 23:30 in Prague
    assert.equal(book.take('a'), 'ok');
    assert.equal(book.take('a'), 'server');
    at('2026-10-27T23:05:00Z'); // 00:05 in Prague, still the 27th in UTC
    assert.equal(book.take('a'), 'ok');
  });

  it('says the cap once a day per server', () => {
    const { book, at } = budget(1, 10);
    book.take('a');
    book.take('a');
    assert.equal(book.firstRefusal('a'), true);
    assert.equal(book.firstRefusal('a'), false);
    at('2026-10-28T10:00:00Z');
    book.take('a');
    assert.equal(book.firstRefusal('a'), true);
  });

  it('a cap of 0 turns Claude off', () => {
    const { book } = budget(0, 10);
    assert.equal(book.take('a'), 'server');
  });
});
