import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from './logger';

/** What this copy should do about the lock file. A broken file is left alone. */
export type LockVerdict = 'ours' | 'missing' | 'unreadable' | 'newer';

/** The other copy, as named in the lock file. Missing fields stay blank. */
export interface NewerCopy {
  host: string;
  pid: string;
  startedAt: string;
}

interface InstanceStamp {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * `data/instance.json` in the process working directory. Every container on
 * the Mac mini sees the same `data/` folder, so a newer boot overwrites this.
 */
export function instanceLockPath(): string {
  return join(process.cwd(), 'data', 'instance.json');
}

/**
 * Decide from the lock file's text. `null` means the file is not there.
 * A file that does not parse, or has no id, is `unreadable`: never treat a
 * broken file as a newer copy, and never overwrite one.
 */
export function lockVerdict(fileText: string | null, ourId: string): LockVerdict {
  if (fileText === null) return 'missing';
  const id = parseId(fileText);
  if (id === null) return 'unreadable';
  return id === ourId ? 'ours' : 'newer';
}

/**
 * Write this process into the lock file and re-read it on an interval.
 * A newer id means another copy has started: `onNewer` runs once and the
 * watch stops. The interval does not keep the process alive.
 */
export function claimInstance(opts: {
  onNewer: (other: NewerCopy) => void;
  logger?: Logger;
  path?: string;
  intervalMs?: number;
}): { stop: () => void } {
  const file = opts.path ?? instanceLockPath();
  const intervalMs = opts.intervalMs ?? 5_000;
  const stamp: InstanceStamp = {
    id: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  writeInstance(file, stamp);

  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const text = readInstance(file);
    if (text === undefined) return;
    const verdict = lockVerdict(text, stamp.id);
    if (verdict === 'ours' || verdict === 'unreadable') return;
    if (verdict === 'missing') {
      writeInstance(file, stamp);
      return;
    }
    if (typeof text !== 'string') return;
    stopped = true;
    clearInterval(timer);
    opts.onNewer(describeNewer(text));
  };
  const timer = setInterval(() => {
    try {
      tick();
    } catch (error) {
      opts.logger?.debug('Instance lock check failed:', error);
    }
  }, intervalMs);
  timer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** The id string, or null when the text is not a lock file. */
function parseId(fileText: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(fileText);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : null;
}

/** Host, pid, and start time for the log. Blank when the file omitted them. */
function describeNewer(fileText: string): NewerCopy {
  let value: unknown;
  try {
    value = JSON.parse(fileText);
  } catch {
    value = null;
  }
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const pid = (row as { pid?: unknown }).pid;
  return {
    host: textField((row as { host?: unknown }).host) ?? 'unknown host',
    pid: typeof pid === 'number' && Number.isInteger(pid) ? String(pid) : 'unknown pid',
    startedAt: textField((row as { startedAt?: unknown }).startedAt) ?? 'unknown time',
  };
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The file text, null when it is missing, undefined when it could not be read.
 * A read error is not "missing": rewriting then could erase the newer copy.
 */
function readInstance(file: string): string | null | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/** Temp file in the same directory, then rename over the old one. */
function writeInstance(file: string, stamp: InstanceStamp): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `instance.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(stamp));
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The temp file is the only leftover; the next write uses a new name.
    }
    throw error;
  }
}
