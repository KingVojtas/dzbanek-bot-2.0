import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesHint } from '../src/deals/targets';

describe('matchesHint', () => {
  it('a short hint must be the whole channel name', () => {
    assert.equal(matchesHint('hi', 'hi'), true);
    assert.equal(matchesHint('chill', 'hi'), false);
    assert.equal(matchesHint('archive', 'hi'), false);
  });

  it('a longer hint may sit inside the name', () => {
    assert.equal(matchesHint('steamdeals', 'deals'), true);
    assert.equal(matchesHint('welcomeandrules', 'welcome'), true);
    assert.equal(matchesHint('freegames', 'freegames'), true);
  });
});
