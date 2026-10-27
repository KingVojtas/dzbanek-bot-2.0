import type { Logger } from '../core/logger';
import { isBotCheck } from './ytdlp-cookies';

/** Today's player clients. A blank `music.youtubeClients` uses this list. */
export const DEFAULT_YOUTUBE_CLIENTS = 'android_vr,tv_simply,mweb,web,web_embedded';

/** One fallback warning, then quiet for an hour. */
export const FALLBACK_WARN_MS = 60 * 60 * 1000;

/** Wait after a passing YouTube check before the first benchmark run. */
export const BENCHMARK_DELAY_MS = 30_000;

/** Gap between benchmark runs so YouTube does not see a burst. */
export const BENCHMARK_GAP_MS = 20_000;

/** Runs per client set per video. */
export const BENCHMARK_RUNS = 2;

export interface ClientSet {
  /** Shown in the log. */
  label: string;
  /** Null omits `player_client` so yt-dlp uses its own default. */
  clients: string | null;
}

/** Tried in this order. The first set is today's list. */
export const YOUTUBE_CLIENT_SETS: readonly ClientSet[] = [
  { label: DEFAULT_YOUTUBE_CLIENTS, clients: DEFAULT_YOUTUBE_CLIENTS },
  { label: 'tv_simply,web_embedded', clients: 'tv_simply,web_embedded' },
  { label: 'tv_simply', clients: 'tv_simply' },
  { label: 'web_embedded', clients: 'web_embedded' },
  { label: 'mweb', clients: 'mweb' },
  { label: 'web', clients: 'web' },
  { label: 'no player_client', clients: null },
];

/** One timed start. `seconds` is set for failures too; the summary ignores those. */
export interface ClientTiming {
  ok: boolean;
  seconds: number;
  error?: string;
}

/** Median, min, and max cover the successful runs. `errors` counts the failures. */
export interface ClientRunSummary {
  ok: number;
  total: number;
  median: number | null;
  min: number | null;
  max: number | null;
  errors: { message: string; count: number }[];
}

export type BenchmarkSpawn = (run: {
  url: string;
  clients: string | null;
}) => Promise<ClientTiming>;

/** Blank, null, or whitespace becomes today's list. Tokens are trimmed. */
export function resolveYouTubeClients(raw?: string | null): string {
  if (raw == null) return DEFAULT_YOUTUBE_CLIENTS;
  const list = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(',');
  return list || DEFAULT_YOUTUBE_CLIENTS;
}

/**
 * yt-dlp `extractorArgs` for these clients.
 * Null means omit `player_client`. Blank uses today's list.
 */
export function playerClientArg(clients?: string | null): string | null {
  if (clients === null) return null;
  return `youtube:player_client=${resolveYouTubeClients(clients)}`;
}

/** True when the last fallback warning is at least an hour old. */
export function shouldWarnFallback(lastAt: number, now: number): boolean {
  return now - lastAt >= FALLBACK_WARN_MS;
}

/** Median, min, max, ok count, and a tally of the failure messages. */
export function summarizeClientRuns(runs: ClientTiming[]): ClientRunSummary {
  const okSeconds = runs.filter((run) => run.ok).map((run) => run.seconds);
  const sorted = [...okSeconds].sort((a, b) => a - b);
  return {
    ok: okSeconds.length,
    total: runs.length,
    median: medianOf(sorted),
    min: sorted.length > 0 ? sorted[0] : null,
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    errors: tallyErrors(runs),
  };
}

export function formatClientRun(label: string, videoId: string, run: ClientTiming): string {
  if (run.ok) {
    return `YouTube client benchmark: "${label}" ${videoId} ok, ${secs(run.seconds)} s`;
  }
  return `YouTube client benchmark: "${label}" ${videoId} failed: ${oneLine(run.error)}`;
}

export function formatClientSummary(label: string, summary: ClientRunSummary): string {
  const head = `YouTube client benchmark: "${label}" ${summary.ok}/${summary.total} ok`;
  if (summary.median == null) {
    if (summary.errors.length === 0) return head;
    return `${head}; errors: ${formatErrors(summary.errors)}.`;
  }
  const mid = `${head}, median ${secs(summary.median)} s`;
  if (summary.errors.length === 0 && summary.min != null && summary.max != null) {
    return `${mid} (${secs(summary.min)}\u2013${secs(summary.max)} s)`;
  }
  return `${mid}; errors: ${formatErrors(summary.errors)}.`;
}

/** Names the fastest set that succeeded on every run, plus today's list. */
export function formatBenchmarkDone(
  sets: { label: string; summary: ClientRunSummary }[],
  todayLabel: string,
): string {
  let fastest: { label: string; median: number } | null = null;
  for (const set of sets) {
    if (set.summary.total === 0 || set.summary.ok !== set.summary.total) continue;
    const median = set.summary.median;
    if (median == null) continue;
    if (!fastest || median < fastest.median) fastest = { label: set.label, median };
  }
  const today = sets.find((set) => set.label === todayLabel);
  const todayText = today ? todayPhrase(today.summary) : 'not measured';
  if (!fastest) {
    return `YouTube client benchmark done: no set was fully reliable; today's list ${todayText}.`;
  }
  return (
    `YouTube client benchmark done: fastest reliable set "${fastest.label}" ` +
    `(median ${secs(fastest.median)} s); today's list ${todayText}.`
  );
}

/** Resolves early when `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Time each client set, one run at a time. `spawn` starts and kills one attempt.
 * A bot check, or `signal` aborting between runs, stops the rest.
 */
export async function runYouTubeClientBenchmark(opts: {
  spawn: BenchmarkSpawn;
  signal: AbortSignal;
  log: Pick<Logger, 'info' | 'warn'>;
  urls: readonly string[];
  sets?: readonly ClientSet[];
  gapMs?: number;
  runsEach?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const sets = opts.sets ?? YOUTUBE_CLIENT_SETS;
  const gapMs = opts.gapMs ?? BENCHMARK_GAP_MS;
  const runsEach = opts.runsEach ?? BENCHMARK_RUNS;
  const sleep = opts.sleep ?? pause;
  const summaries: { label: string; summary: ClientRunSummary }[] = [];
  let first = true;

  for (const set of sets) {
    if (opts.signal.aborted) {
      opts.log.info('YouTube client benchmark stopped.');
      return;
    }
    const timings: ClientTiming[] = [];
    let halted = false;
    for (const url of opts.urls) {
      for (let n = 0; n < runsEach; n++) {
        if (opts.signal.aborted) {
          halted = true;
          break;
        }
        if (!first) {
          await sleep(gapMs, opts.signal);
          if (opts.signal.aborted) {
            halted = true;
            break;
          }
        }
        first = false;
        const timing = await opts.spawn({ url, clients: set.clients });
        const videoId = videoIdOf(url);
        opts.log.info(formatClientRun(set.label, videoId, timing));
        timings.push(timing);
        if (!timing.ok && isBotCheck(timing.error ?? '')) {
          opts.log.warn(
            `YouTube client benchmark stopped: bot check on "${set.label}" (${videoId}).`,
          );
          return;
        }
      }
      if (halted) break;
    }
    if (halted) {
      opts.log.info('YouTube client benchmark stopped.');
      return;
    }
    const summary = summarizeClientRuns(timings);
    summaries.push({ label: set.label, summary });
    opts.log.info(formatClientSummary(set.label, summary));
  }

  const today = sets[0]?.label ?? DEFAULT_YOUTUBE_CLIENTS;
  opts.log.info(formatBenchmarkDone(summaries, today));
}

function medianOf(sorted: number[]): number | null {
  const count = sorted.length;
  if (count === 0) return null;
  const mid = Math.floor(count / 2);
  if (count % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function tallyErrors(runs: ClientTiming[]): { message: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.ok) continue;
    const message = oneLine(run.error);
    if (!counts.has(message)) order.push(message);
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return order
    .map((message) => ({ message, count: counts.get(message) ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

function formatErrors(errors: { message: string; count: number }[]): string {
  return errors.map((error) => `${error.message} (${error.count})`).join(', ');
}

function todayPhrase(summary: ClientRunSummary): string {
  if (summary.ok === summary.total && summary.median != null) return `${secs(summary.median)} s`;
  if (summary.median != null) {
    return `${summary.ok}/${summary.total} ok, median ${secs(summary.median)} s`;
  }
  return `${summary.ok}/${summary.total} ok`;
}

function secs(value: number): string {
  return value.toFixed(1);
}

function oneLine(error?: string): string {
  const text = (error ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return text || 'unknown error';
}

function videoIdOf(url: string): string {
  try {
    return new URL(url).searchParams.get('v') || url;
  } catch {
    return url;
  }
}
