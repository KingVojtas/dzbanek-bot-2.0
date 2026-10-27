import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import type { Track } from '../src/core/types';
import { YouTubeSource } from '../src/music/sources/youtube';
import { DEFAULT_YOUTUBE_CLIENTS } from '../src/music/youtube-clients';

const URL = 'https://www.youtube.com/watch?v=o_2t4TrXPvs';
const FORMAT = 'Requested format is not available';
const BOT = "Sign in to confirm you're not a bot.";

function track(over: Partial<Track> = {}): Track {
  return {
    title: 'Song',
    url: URL,
    durationSec: 200,
    requestedBy: 'tester',
    ...over,
  };
}

type Step = { ok: true } | { ok: false; error: string };

function scripted(steps: Step[]) {
  const calls: { url: string; printId: boolean; clients: string | null }[] = [];
  const audios: PassThrough[] = [];
  const open = (url: string, printId: boolean, clients: string | null) => {
    calls.push({ url, printId, clients });
    const step = steps.shift() ?? { ok: false as const, error: 'no script' };
    const audio = new PassThrough();
    audio.on('error', () => {});
    audios.push(audio);
    let started = (): void => {};
    let failed = (_error: Error): void => {};
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    ready.catch(() => {});
    setImmediate(() => {
      if (step.ok) {
        started();
        audio.write(Buffer.from([1]));
        return;
      }
      const error = new Error(step.error);
      failed(error);
      if (!audio.destroyed) audio.destroy(error);
    });
    return { audio, ready, videoId: Promise.resolve<string | null>(null) };
  };
  return { open, calls, audios };
}

describe('YouTube client fallback', () => {
  it("retries a failed custom list once with today's list", async () => {
    const warns: string[] = [];
    const { open, calls, audios } = scripted([{ ok: false, error: FORMAT }, { ok: true }]);
    const source = new YouTubeSource('tv_simply', open, (message) => warns.push(message));
    const audio = await source.stream(track({ title: 'First' }));
    assert.equal(audio, audios[1]);
    assert.deepEqual(
      calls.map((call) => call.clients),
      ['tv_simply', DEFAULT_YOUTUBE_CLIENTS],
    );
    assert.deepEqual(warns, [
      'YouTube clients "tv_simply" failed for "First"; used the default list.',
    ]);
    audio.destroy();
  });

  it('retries HTTP 403 the same way, and does not try a third time', async () => {
    const { open, calls } = scripted([
      { ok: false, error: 'HTTP Error 403: Forbidden' },
      { ok: false, error: FORMAT },
    ]);
    const source = new YouTubeSource('web_embedded', open, () => {});
    await assert.rejects(() => source.stream(track()), /Requested format is not available/);
    assert.deepEqual(
      calls.map((call) => call.clients),
      ['web_embedded', DEFAULT_YOUTUBE_CLIENTS],
    );
  });

  it('logs the first fallback of the hour and still retries the next song', async () => {
    const warns: string[] = [];
    const { open, calls } = scripted([
      { ok: false, error: FORMAT },
      { ok: true },
      { ok: false, error: FORMAT },
      { ok: true },
    ]);
    const source = new YouTubeSource('mweb', open, (message) => warns.push(message));
    const first = await source.stream(track({ title: 'First' }));
    const second = await source.stream(track({ title: 'Second' }));
    first.destroy();
    second.destroy();
    assert.equal(calls.length, 4);
    assert.deepEqual(warns, ['YouTube clients "mweb" failed for "First"; used the default list.']);
  });

  it('leaves a bot check on the SoundCloud path', async () => {
    const warns: string[] = [];
    const { open, calls } = scripted([{ ok: false, error: BOT }]);
    const source = new YouTubeSource('tv_simply', open, (message) => warns.push(message));
    await assert.rejects(
      () => source.stream(track({ title: 'Blocked', durationSec: 0 })),
      /not a bot/,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(warns, []);
  });

  it("does not retry when the configured list is today's list", async () => {
    for (const clients of [undefined, '', 'android_vr, tv_simply, mweb, web, web_embedded']) {
      const warns: string[] = [];
      const { open, calls } = scripted([{ ok: false, error: FORMAT }]);
      const source = new YouTubeSource(clients, open, (message) => warns.push(message));
      await assert.rejects(() => source.stream(track()), /not available/);
      assert.deepEqual(
        calls.map((call) => call.clients),
        [DEFAULT_YOUTUBE_CLIENTS],
      );
      assert.deepEqual(warns, []);
    }
  });

  it('retries a warm stream through the same path prefetch uses', async () => {
    const warns: string[] = [];
    const { open, calls, audios } = scripted([{ ok: false, error: FORMAT }, { ok: true }]);
    const source = new YouTubeSource('tv_simply,web', open, (message) => warns.push(message));
    source.warm(URL);
    const audio = await source.stream(track({ title: 'Warm' }));
    assert.equal(audio, audios[1]);
    assert.deepEqual(
      calls.map((call) => call.clients),
      ['tv_simply,web', DEFAULT_YOUTUBE_CLIENTS],
    );
    assert.equal(calls[0].printId, false);
    assert.deepEqual(warns, [
      'YouTube clients "tv_simply,web" failed for "Warm"; used the default list.',
    ]);
    audio.destroy();
  });

  it('does not retry a warm stream that hit a bot check', async () => {
    const { open, calls } = scripted([{ ok: false, error: BOT }]);
    const source = new YouTubeSource('tv_simply', open, () => {});
    source.warm(URL);
    await assert.rejects(() => source.stream(track({ durationSec: 0 })), /not a bot/);
    assert.equal(calls.length, 1);
  });
});
