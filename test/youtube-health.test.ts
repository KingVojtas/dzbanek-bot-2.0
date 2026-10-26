import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../src/core/logger';
import { YouTubeHealth } from '../src/music/youtube-health';

const BOT_CHECK = '[youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot.';
const quiet = new Logger('error');

/** A health check whose probe answers from `answers`, in turn, and whose DMs land in `sent`. */
function setup(answers: (string | null)[]) {
  let clock = 0;
  let probes = 0;
  const sent: string[] = [];
  const health = new YouTubeHealth(
    () => Promise.resolve(answers[Math.min(probes++, answers.length - 1)] ?? null),
    quiet,
    () => clock,
  );
  health.setAlert((text) => void sent.push(text));
  return {
    health,
    sent,
    probes: () => probes,
    advance: (ms: number) => (clock += ms),
  };
}

describe('YouTubeHealth', () => {
  it('DMs once when the sign-in runs out, not on every check after', async () => {
    const { health, sent } = setup([BOT_CHECK]);
    await health.check();
    await health.check();
    assert.equal(health.state, 'blocked');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /fresh sign-in/);
    assert.match(sent[0], /Sign in to confirm/);
  });

  it('DMs again when YouTube works, whether a check or a song says so', async () => {
    const viaCheck = setup([BOT_CHECK, null]);
    await viaCheck.health.check();
    await viaCheck.health.check();
    assert.equal(viaCheck.health.state, 'ok');
    assert.equal(viaCheck.sent.length, 2);
    assert.match(viaCheck.sent[0], /fresh sign-in/);
    assert.match(viaCheck.sent[1], /works again/);

    const viaSong = setup([BOT_CHECK]);
    await viaSong.health.check();
    await viaSong.health.working();
    assert.equal(viaSong.sent.length, 2);
    assert.match(viaSong.sent[1], /works again/);
  });

  it('sends nothing when a song is blocked but the test song plays', async () => {
    const { health, sent } = setup([null]);
    health.suspect();
    await health.check();
    assert.equal(health.state, 'ok');
    assert.equal(sent.length, 0);
  });

  it('probes at most every 5 minutes for blocked songs', async () => {
    const { health, probes, advance } = setup([BOT_CHECK]);
    health.suspect();
    await health.check();
    advance(60_000);
    health.suspect();
    await health.check();
    // The second check() ran on purpose; the second suspect() did not.
    assert.equal(probes(), 2);
    advance(5 * 60_000);
    health.suspect();
    assert.equal(probes(), 3);
  });

  it('shares a check already under way', async () => {
    const { health, probes } = setup([null]);
    await Promise.all([health.check(), health.check()]);
    assert.equal(probes(), 1);
  });

  it('does not blame the sign-in for a network failure', async () => {
    const { health, sent } = setup(['Unable to download webpage: timed out']);
    await health.check();
    assert.equal(health.state, 'unknown');
    assert.equal(sent.length, 0);
  });
});
