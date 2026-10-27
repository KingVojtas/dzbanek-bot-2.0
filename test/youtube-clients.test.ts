import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { CLIENT_BENCHMARK_URLS, PROBE_URL, timeYouTubeClient } from '../src/music/sources/youtube';
import {
  BENCHMARK_DELAY_MS,
  BENCHMARK_GAP_MS,
  BENCHMARK_RUNS,
  DEFAULT_YOUTUBE_CLIENTS,
  FALLBACK_WARN_MS,
  YOUTUBE_CLIENT_SETS,
  formatBenchmarkDone,
  formatClientRun,
  formatClientSummary,
  pause,
  playerClientArg,
  resolveYouTubeClients,
  runYouTubeClientBenchmark,
  shouldWarnFallback,
  summarizeClientRuns,
  type ClientTiming,
} from '../src/music/youtube-clients';

const PROBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const SONG = 'https://www.youtube.com/watch?v=o_2t4TrXPvs';

function logTo(lines: string[]) {
  return {
    info: (message: string) => lines.push(message),
    warn: (message: string) => lines.push(`WARN ${message}`),
  };
}

describe('YouTube client list', () => {
  it("keeps today's list when the setting is blank", () => {
    assert.equal(resolveYouTubeClients(undefined), DEFAULT_YOUTUBE_CLIENTS);
    assert.equal(resolveYouTubeClients(null), DEFAULT_YOUTUBE_CLIENTS);
    assert.equal(resolveYouTubeClients(''), DEFAULT_YOUTUBE_CLIENTS);
    assert.equal(resolveYouTubeClients(' , '), DEFAULT_YOUTUBE_CLIENTS);
    assert.equal(
      resolveYouTubeClients(' android_vr , tv_simply , mweb , web , web_embedded '),
      DEFAULT_YOUTUBE_CLIENTS,
    );
  });

  it('builds the extractor arg, or omits it', () => {
    assert.equal(playerClientArg(undefined), `youtube:player_client=${DEFAULT_YOUTUBE_CLIENTS}`);
    assert.equal(playerClientArg('tv_simply'), 'youtube:player_client=tv_simply');
    assert.equal(playerClientArg(null), null);
  });

  it('warns about a fallback at most once an hour', () => {
    assert.equal(FALLBACK_WARN_MS, 60 * 60 * 1000);
    assert.equal(shouldWarnFallback(-Infinity, 0), true);
    assert.equal(shouldWarnFallback(0, FALLBACK_WARN_MS - 1), false);
    assert.equal(shouldWarnFallback(0, FALLBACK_WARN_MS), true);
  });
});

describe('YouTube client benchmark summary', () => {
  it('reports median, min, max, and the error tally', () => {
    const full = summarizeClientRuns([
      { ok: true, seconds: 5 },
      { ok: true, seconds: 3.8 },
      { ok: true, seconds: 4.2 },
      { ok: true, seconds: 4 },
    ]);
    assert.equal(full.ok, 4);
    assert.equal(full.total, 4);
    assert.equal(full.min, 3.8);
    assert.equal(full.max, 5);
    assert.equal(full.median?.toFixed(1), '4.1');
    assert.deepEqual(full.errors, []);
    assert.equal(
      formatClientSummary('tv_simply,web_embedded', full),
      'YouTube client benchmark: "tv_simply,web_embedded" 4/4 ok, median 4.1 s (3.8\u20135.0 s)',
    );

    const even = summarizeClientRuns([
      { ok: true, seconds: 1 },
      { ok: true, seconds: 4 },
      { ok: true, seconds: 2 },
      { ok: true, seconds: 3 },
    ]);
    assert.equal(even.median, 2.5);
    assert.equal(even.min, 1);
    assert.equal(even.max, 4);

    const partial = summarizeClientRuns([
      { ok: false, seconds: 1, error: 'Requested format is not available' },
      { ok: true, seconds: 9.2 },
      { ok: false, seconds: 2, error: 'Requested format is not available' },
      { ok: false, seconds: 30, error: 'HTTP Error 403: Forbidden' },
    ]);
    assert.equal(partial.ok, 1);
    assert.equal(partial.median, 9.2);
    assert.equal(partial.min, 9.2);
    assert.equal(partial.max, 9.2);
    assert.deepEqual(partial.errors, [
      { message: 'Requested format is not available', count: 2 },
      { message: 'HTTP Error 403: Forbidden', count: 1 },
    ]);
    assert.equal(
      formatClientSummary('web', partial),
      'YouTube client benchmark: "web" 1/4 ok, median 9.2 s; errors: Requested format is not available (2), HTTP Error 403: Forbidden (1).',
    );
  });

  it('collapses a failure onto one line and counts blanks as unknown', () => {
    const summary = summarizeClientRuns([
      { ok: false, seconds: 1, error: 'Requested   format\nis not available' },
      { ok: false, seconds: 1, error: '   ' },
    ]);
    assert.deepEqual(summary.errors, [
      { message: 'Requested format is not available', count: 1 },
      { message: 'unknown error', count: 1 },
    ]);
    assert.equal(
      formatClientSummary('mweb', summary),
      'YouTube client benchmark: "mweb" 0/2 ok; errors: Requested format is not available (1), unknown error (1).',
    );
    assert.equal(
      formatClientRun('mweb', 'jNQXAC9IVRw', summaryRun('Requested   format\nis not available')),
      'YouTube client benchmark: "mweb" jNQXAC9IVRw failed: Requested format is not available',
    );
  });

  it('names the fastest fully reliable set, and keeps the first tie', () => {
    const reliable = (median: number) =>
      summarizeClientRuns([
        { ok: true, seconds: median },
        { ok: true, seconds: median },
        { ok: true, seconds: median },
        { ok: true, seconds: median },
      ]);
    const today = reliable(6.4);
    const fast = reliable(4.1);
    const tied = reliable(4.1);
    const shaky = summarizeClientRuns([
      { ok: true, seconds: 1 },
      { ok: false, seconds: 1, error: 'HTTP Error 403: Forbidden' },
      { ok: false, seconds: 1, error: 'HTTP Error 403: Forbidden' },
      { ok: false, seconds: 1, error: 'HTTP Error 403: Forbidden' },
    ]);
    assert.equal(
      formatBenchmarkDone(
        [
          { label: DEFAULT_YOUTUBE_CLIENTS, summary: today },
          { label: 'tv_simply', summary: fast },
          { label: 'web', summary: tied },
          { label: 'mweb', summary: shaky },
        ],
        DEFAULT_YOUTUBE_CLIENTS,
      ),
      'YouTube client benchmark done: fastest reliable set "tv_simply" (median 4.1 s); today\'s list 6.4 s.',
    );
    assert.equal(
      formatBenchmarkDone(
        [{ label: DEFAULT_YOUTUBE_CLIENTS, summary: shaky }],
        DEFAULT_YOUTUBE_CLIENTS,
      ),
      "YouTube client benchmark done: no set was fully reliable; today's list 1/4 ok, median 1.0 s.",
    );
  });
});

describe('YouTube client benchmark run', () => {
  it('uses the health-check song and one music video, in the candidate order', () => {
    assert.equal(BENCHMARK_DELAY_MS, 30_000);
    assert.equal(BENCHMARK_GAP_MS, 20_000);
    assert.equal(BENCHMARK_RUNS, 2);
    assert.deepEqual(CLIENT_BENCHMARK_URLS, [PROBE_URL, SONG]);
    assert.equal(PROBE_URL, PROBE);
    assert.deepEqual(
      YOUTUBE_CLIENT_SETS.map((set) => set.clients),
      [
        DEFAULT_YOUTUBE_CLIENTS,
        'tv_simply,web_embedded',
        'tv_simply',
        'web_embedded',
        'mweb',
        'web',
        null,
      ],
    );
  });

  it('runs one at a time, 20 s apart, and names the fastest reliable set', async () => {
    const calls: (string | null)[] = [];
    const sleeps: number[] = [];
    const lines: string[] = [];
    await runYouTubeClientBenchmark({
      signal: new AbortController().signal,
      log: logTo(lines),
      urls: CLIENT_BENCHMARK_URLS,
      spawn: async (run) => {
        calls.push(run.clients);
        const seconds = run.clients === 'tv_simply' ? 2 : run.clients === null ? 9 : 5;
        return { ok: true, seconds };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(calls.length, 28);
    assert.equal(sleeps.length, 27);
    assert.ok(sleeps.every((ms) => ms === 20_000));
    assert.deepEqual(calls.slice(0, 4), Array(4).fill(DEFAULT_YOUTUBE_CLIENTS));
    assert.deepEqual(calls.slice(8, 12), Array(4).fill('tv_simply'));
    assert.deepEqual(calls.slice(24), [null, null, null, null]);
    assert.ok(lines.includes('YouTube client benchmark: "tv_simply" jNQXAC9IVRw ok, 2.0 s'));
    assert.ok(
      lines.includes('YouTube client benchmark: "tv_simply" 4/4 ok, median 2.0 s (2.0\u20132.0 s)'),
    );
    assert.equal(
      lines.at(-1),
      'YouTube client benchmark done: fastest reliable set "tv_simply" (median 2.0 s); today\'s list 5.0 s.',
    );
  });

  it('stops the rest on a bot check', async () => {
    let spawned = 0;
    const lines: string[] = [];
    await runYouTubeClientBenchmark({
      signal: new AbortController().signal,
      log: logTo(lines),
      urls: [PROBE, SONG],
      sets: [
        { label: 'tv_simply', clients: 'tv_simply' },
        { label: 'web', clients: 'web' },
      ],
      gapMs: 20_000,
      spawn: async () => {
        spawned += 1;
        return { ok: false, seconds: 3, error: "Sign in to confirm you're not a bot." };
      },
      sleep: async () => {
        throw new Error('should have stopped before the gap');
      },
    });
    assert.equal(spawned, 1);
    assert.deepEqual(lines, [
      'YouTube client benchmark: "tv_simply" jNQXAC9IVRw failed: Sign in to confirm you\'re not a bot.',
      'WARN YouTube client benchmark stopped: bot check on "tv_simply" (jNQXAC9IVRw).',
    ]);
  });

  it('stops between runs when this copy goes idle', async () => {
    const controller = new AbortController();
    let spawned = 0;
    const lines: string[] = [];
    await runYouTubeClientBenchmark({
      signal: controller.signal,
      log: logTo(lines),
      urls: [PROBE],
      sets: [{ label: 'tv_simply', clients: 'tv_simply' }],
      runsEach: 2,
      spawn: async () => {
        spawned += 1;
        return { ok: true, seconds: 1 };
      },
      sleep: async () => {
        controller.abort();
      },
    });
    assert.equal(spawned, 1);
    assert.equal(lines.at(-1), 'YouTube client benchmark stopped.');
    assert.equal(
      lines.some((line) => line.includes('1/2')),
      false,
    );
  });

  it('pause returns immediately once the signal has aborted', async () => {
    const started = Date.now();
    await pause(60_000, AbortSignal.abort());
    const controller = new AbortController();
    const pending = pause(60_000, controller.signal);
    controller.abort();
    await pending;
    assert.ok(Date.now() - started < 1000);
  });
});

describe('timeYouTubeClient', () => {
  it('kills the stream once audio starts, and on a failure too', async () => {
    const started = new PassThrough();
    const startedClosed = new Promise<void>((resolve) => started.on('close', () => resolve()));
    let clients: string | null = 'unset';
    const ok = await timeYouTubeClient(PROBE, null, (_url, _printId, list) => {
      clients = list;
      return { audio: started, ready: Promise.resolve(), videoId: Promise.resolve(null) };
    });
    await startedClosed;
    assert.equal(ok.ok, true);
    assert.equal(clients, null);
    assert.equal(started.destroyed, true);

    const failed = new PassThrough();
    failed.on('error', () => {});
    const failedClosed = new Promise<void>((resolve) => failed.on('close', () => resolve()));
    let reject: (error: Error) => void = () => {};
    const ready = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    ready.catch(() => {});
    const pending = timeYouTubeClient(SONG, 'web', () => ({
      audio: failed,
      ready,
      videoId: Promise.resolve(null),
    }));
    reject(new Error('HTTP Error 403: Forbidden'));
    const timing = await pending;
    await failedClosed;
    assert.equal(timing.ok, false);
    assert.equal(timing.error, 'HTTP Error 403: Forbidden');
    assert.equal(failed.destroyed, true);
  });
});

function summaryRun(error: string): ClientTiming {
  return { ok: false, seconds: 1, error };
}
