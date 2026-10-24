import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyCounts, isStationId, pickWinner, voteLeader } from '../src/kitchen/vote-tally';
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
