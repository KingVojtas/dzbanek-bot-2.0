import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { claimInstance, lockVerdict, type NewerCopy } from '../src/core/instance-lock';

const root = mkdtempSync(join(tmpdir(), 'instance-lock-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function freshFile(): string {
  const dir = join(root, String(n++));
  return join(dir, 'instance.json');
}

function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timed out'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('lockVerdict', () => {
  const ours = 'copy-a';

  it('treats a missing file as missing and our id as ours', () => {
    assert.equal(lockVerdict(null, ours), 'missing');
    assert.equal(lockVerdict(JSON.stringify({ id: ours, pid: 1 }), ours), 'ours');
  });

  it('treats a different id as a newer copy', () => {
    assert.equal(lockVerdict(JSON.stringify({ id: 'copy-b' }), ours), 'newer');
    assert.equal(lockVerdict(`\n${JSON.stringify({ id: 'copy-b' })}\n`, ours), 'newer');
  });

  it('does not act on a file that cannot be parsed', () => {
    assert.equal(lockVerdict('', ours), 'unreadable');
    assert.equal(lockVerdict('{', ours), 'unreadable');
    assert.equal(lockVerdict('[]', ours), 'unreadable');
    assert.equal(lockVerdict('{}', ours), 'unreadable');
    assert.equal(lockVerdict(JSON.stringify({ id: '' }), ours), 'unreadable');
    assert.equal(lockVerdict(JSON.stringify({ id: 4 }), ours), 'unreadable');
    assert.equal(lockVerdict('null', ours), 'unreadable');
  });
});

describe('claimInstance', () => {
  it('writes this process, then notices a newer id and stops checking', async () => {
    const file = freshFile();
    const seen: NewerCopy[] = [];
    const first = claimInstance({
      path: file,
      intervalMs: 30,
      onNewer: (other) => seen.push(other),
    });
    const written = JSON.parse(readFileSync(file, 'utf8')) as {
      id: string;
      pid: number;
      host: string;
      startedAt: string;
    };
    assert.equal(written.pid, process.pid);
    assert.equal(written.host, hostname());
    assert.ok(written.id);
    assert.ok(!Number.isNaN(Date.parse(written.startedAt)));

    const second = claimInstance({
      path: file,
      intervalMs: 60_000,
      onNewer: () => {},
    });
    const again = JSON.parse(readFileSync(file, 'utf8')) as { id: string };
    assert.notEqual(again.id, written.id);
    assert.equal(
      readdirSync(dirname(file)).some((name) => name.endsWith('.tmp')),
      false,
    );

    await waitFor(() => seen.length > 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.host, hostname());
    assert.equal(seen[0]?.pid, String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(seen.length, 1);

    first.stop();
    second.stop();
  });

  it('writes its id again when the file disappears, and leaves a broken file alone', async () => {
    const file = freshFile();
    const seen: NewerCopy[] = [];
    const claim = claimInstance({
      path: file,
      intervalMs: 30,
      onNewer: (other) => seen.push(other),
    });
    const id = (JSON.parse(readFileSync(file, 'utf8')) as { id: string }).id;
    rmSync(file);
    await waitFor(() => {
      try {
        return (JSON.parse(readFileSync(file, 'utf8')) as { id: string }).id === id;
      } catch {
        return false;
      }
    });

    writeFileSync(file, '{');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(readFileSync(file, 'utf8'), '{');
    assert.equal(seen.length, 0);
    claim.stop();
  });
});
