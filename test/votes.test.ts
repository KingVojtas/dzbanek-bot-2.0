import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emptyCounts,
  isStationId,
  pickWinner,
  voteLeader,
  voteTally,
  voteTotal,
} from '../src/kitchen/vote-tally';
import { STATION_LIST } from '../src/radio/station';

function counts(values: Partial<ReturnType<typeof emptyCounts>>) {
  return { ...emptyCounts(), ...values };
}

describe('emptyCounts', () => {
  it('has a zero for every station', () => {
    const empty = emptyCounts();
    assert.deepEqual(Object.keys(empty).sort(), STATION_LIST.map((s) => s.id).sort());
    assert.ok(Object.values(empty).every((n) => n === 0));
  });
});

describe('voteTotal', () => {
  it('counts every station, not only the first three', () => {
    assert.equal(voteTotal(counts({ frekvence1: 1, heart: 2, capital: 3, paradise: 4 })), 10);
    assert.equal(voteTotal(counts({ kiss: 1, paradise: 1 })), 2);
    assert.equal(voteTotal(emptyCounts()), 0);
  });
});

describe('voteTally', () => {
  it('lists stations with votes, in catalog order', () => {
    assert.equal(
      voteTally(counts({ paradise: 4, rock: 1, frekvence1: 2 })),
      'Rock 1 · F1 2 · Paradise 4',
    );
  });

  it('is empty with no votes', () => {
    assert.equal(voteTally(emptyCounts()), '');
  });
});

describe('isStationId', () => {
  it('knows the catalog', () => {
    assert.equal(isStationId('beat'), true);
    assert.equal(isStationId('nope'), false);
  });
});

describe('pickWinner', () => {
  it('picks the most votes', () => {
    assert.equal(pickWinner(counts({ kiss: 1, rock: 4, beat: 2 }), 'beat'), 'rock');
  });

  it('gives a tie to the tie-break station when it is tied', () => {
    assert.equal(pickWinner(counts({ kiss: 3, rock: 3 }), 'rock'), 'rock');
  });

  it('gives a tie to the first listed when the tie-break is not tied', () => {
    assert.equal(pickWinner(counts({ kiss: 3, rock: 3 }), 'beat'), 'kiss');
  });

  it('falls back to the tie-break with no votes', () => {
    assert.equal(pickWinner(emptyCounts(), 'rock'), 'rock');
  });
});

describe('voteLeader', () => {
  it('names the station ahead', () => {
    assert.equal(voteLeader(counts({ beat: 2, kiss: 1 })), 'beat');
  });

  it('has no leader in a tie or with no votes', () => {
    assert.equal(voteLeader(counts({ beat: 2, kiss: 2 })), null);
    assert.equal(voteLeader(emptyCounts()), null);
  });
});
