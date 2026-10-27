import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTwinSession } from '../src/core/twin-watch';

const packet = {
  user_id: 'bot',
  channel_id: 'voice',
  session_id: 'other-session',
  guild_id: 'guild',
};

describe('isTwinSession', () => {
  it('is a twin when another session of this bot is in a channel', () => {
    assert.equal(isTwinSession(packet, 'bot', 'our-session'), true);
  });

  it('is not a twin for our own session, a leave, or someone else', () => {
    assert.equal(isTwinSession(packet, 'bot', 'other-session'), false);
    assert.equal(isTwinSession(packet, 'bot', null), false);
    assert.equal(isTwinSession({ ...packet, user_id: 'human' }, 'bot', 'our-session'), false);
    assert.equal(isTwinSession({ ...packet, channel_id: null }, 'bot', 'our-session'), false);
    assert.equal(isTwinSession({ ...packet, channel_id: '' }, 'bot', 'our-session'), false);
    assert.equal(isTwinSession({ ...packet, session_id: '' }, 'bot', 'our-session'), false);
  });

  it('ignores a packet that is not a voice state', () => {
    assert.equal(isTwinSession(null, 'bot', 'our-session'), false);
    assert.equal(isTwinSession('nope', 'bot', 'our-session'), false);
    assert.equal(isTwinSession({}, 'bot', 'our-session'), false);
  });
});
