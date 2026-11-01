import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseConfig } from '../src/config';
import type { Logger } from '../src/core/logger';
import { extractTarGz, parseTarHeader } from '../src/fm/piper-archive';
import {
  DEFAULT_PIPER_JINGLE_VOICE,
  DEFAULT_PIPER_VOICE,
  PIPER_BINARY,
  PIPER_RELEASE,
  PIPER_VOICES,
  type PinnedFile,
} from '../src/fm/piper-pins';
import {
  ChainVoice,
  PiperQueue,
  PiperVoice,
  djVoiceIdentity,
  installPiper,
  openKitchenVoices,
  sampleRateOf,
  waitForReady,
  type PiperCatalog,
  type PiperSpawn,
  type SpawnedPiper,
} from '../src/fm/piper';
import { pcmLoudness, MIN_LOUDNESS_DB } from '../src/fm/voice';

function logs(): { infos: string[]; warns: string[]; logger: Logger } {
  const infos: string[] = [];
  const warns: string[] = [];
  const logger = {
    debug() {},
    info(message: string) {
      infos.push(message);
    },
    warn(message: string) {
      warns.push(message);
    },
    error() {},
  } as unknown as Logger;
  return { infos, warns, logger };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'piper-test-'));
}

function tone(samples: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(amplitude, i * 2);
  return pcm;
}

/** 6.2 s of mono at 22050 Hz. The bytes are a stand-in; FFmpeg is faked. */
function speechRaw(): Buffer {
  return Buffer.alloc(Math.round(6.2 * 22_050) * 2, 1);
}

async function ticks(count = 4): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Yields to timers so file I/O can finish. A tight setImmediate loop never does. */
async function later(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeStdin {
  write(chunk: string | Buffer): boolean;
  end(): void;
  on(): FakeStdin;
}

interface FakeByteStream {
  on(event: string, fn: (chunk: Buffer) => void): FakeByteStream;
}

class FakeChild {
  pid = 4242;
  killed = false;
  stdinText = '';
  private closed = false;
  private closeFns: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private stdoutFns: ((chunk: Buffer) => void)[] = [];
  private stderrFns: ((chunk: Buffer) => void)[] = [];
  /** Called when the line has been written and stdin closed. */
  onStdin: (() => void) | null = null;

  stdin: FakeStdin = {
    write: (chunk: string | Buffer): boolean => {
      this.stdinText += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    },
    end: (): void => {
      this.onStdin?.();
    },
    on: (): FakeStdin => this.stdin,
  };

  stdout: FakeByteStream = {
    on: (event: string, fn: (chunk: Buffer) => void): FakeByteStream => {
      if (event === 'data') this.stdoutFns.push(fn);
      return this.stdout;
    },
  };

  stderr: FakeByteStream = {
    on: (event: string, fn: (chunk: Buffer) => void): FakeByteStream => {
      if (event === 'data') this.stderrFns.push(fn);
      return this.stderr;
    },
  };

  once(
    event: 'close' | 'error',
    fn: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    if (event === 'close') this.closeFns.push(fn);
  }

  kill(): boolean {
    this.killed = true;
    this.emitClose(null, 'SIGTERM');
    return true;
  }

  pushStdout(buf: Buffer): void {
    for (const fn of this.stdoutFns) fn(buf);
  }

  pushStderr(text: string): void {
    for (const fn of this.stderrFns) fn(Buffer.from(text));
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeFns) fn(code, signal);
  }
}

function asSpawned(child: FakeChild): SpawnedPiper {
  return child as unknown as SpawnedPiper;
}

function headerChecksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  return sum;
}

function putOctal(block: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  block.write(text, offset, length - 1, 'ascii');
  block[offset + length - 1] = 0;
}

function headerFor(options: {
  name: string;
  prefix?: string;
  mode?: number;
  size?: number;
  type: '0' | '5' | '2';
  linkname?: string;
}): Buffer {
  const block = Buffer.alloc(512);
  block.write(options.name, 0, 'utf8');
  putOctal(block, options.mode ?? 0o644, 100, 8);
  putOctal(block, 0, 108, 8);
  putOctal(block, 0, 116, 8);
  putOctal(block, options.size ?? 0, 124, 12);
  putOctal(block, 0, 136, 12);
  block.fill(0x20, 148, 156);
  block[156] = options.type.charCodeAt(0);
  if (options.linkname) block.write(options.linkname, 157, 'utf8');
  block.write('ustar', 257, 'ascii');
  block.write('00', 263, 'ascii');
  if (options.prefix) block.write(options.prefix, 345, 'utf8');
  const sum = headerChecksum(block);
  block.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function fileEntry(name: string, body: Buffer, mode = 0o644, prefix?: string): Buffer {
  const header = headerFor({ name, prefix, mode, size: body.length, type: '0' });
  const pad = (512 - (body.length % 512)) % 512;
  return Buffer.concat([header, body, Buffer.alloc(pad)]);
}

function metaEntry(options: {
  name: string;
  type: '5' | '2';
  mode?: number;
  linkname?: string;
  prefix?: string;
}): Buffer {
  return headerFor({ ...options, size: 0 });
}

function tarGz(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function pin(name: string, url: string, body: Buffer): PinnedFile {
  return {
    name,
    url,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

/** A tiny stand-in for the pinned release: a binary, espeak data, and three voices. */
function fixture(): { catalog: PiperCatalog; files: Map<string, Buffer> } {
  const archive = tarGz([
    metaEntry({ name: 'piper', type: '5', mode: 0o755 }),
    fileEntry('piper/piper', Buffer.from('bin'), 0o755),
    metaEntry({ name: 'piper/espeak-ng-data', type: '5', mode: 0o755 }),
    fileEntry('piper/espeak-ng-data/phontab', Buffer.from('phones')),
  ]);
  const voices = {
    'en_US-ryan-high': {
      model: Buffer.from('high-model'),
      config: Buffer.from('{"audio":{"sample_rate":22050}}'),
    },
    'en_US-ryan-medium': {
      model: Buffer.from('medium-model'),
      config: Buffer.from('{"audio":{"sample_rate":22050}}'),
    },
    'en_GB-alan-medium': {
      model: Buffer.from('alan-model'),
      config: Buffer.from('{"audio":{"sample_rate":22050}}'),
    },
  };
  const binary = pin('test-release', 'https://pins.test/piper.tar.gz', archive);
  const table: PiperCatalog['voices'] = {};
  const files = new Map<string, Buffer>([[binary.url, archive]]);
  for (const [id, body] of Object.entries(voices)) {
    const model = pin(id, `https://pins.test/${id}.onnx`, body.model);
    const config = pin(`${id}.onnx.json`, `https://pins.test/${id}.onnx.json`, body.config);
    table[id] = { model, config };
    files.set(model.url, body.model);
    files.set(config.url, body.config);
  }
  return { catalog: { release: 'test-release', binary, voices: table }, files };
}

function fakeFetch(
  files: Map<string, Buffer>,
  calls: string[],
  options: { failFirst?: string; wrong?: string } = {},
): typeof fetch {
  const seen = new Map<string, number>();
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const count = (seen.get(url) ?? 0) + 1;
    seen.set(url, count);
    if (options.failFirst === url && count === 1) throw new Error('reset');
    const body = files.get(url);
    if (!body) return new Response('missing', { status: 404 });
    if (options.wrong === url) {
      const flipped = Buffer.from(body);
      flipped[0] = flipped[0]! ^ 0xff;
      return new Response(flipped);
    }
    return new Response(body);
  }) as typeof fetch;
}

describe('pinned Piper files', () => {
  it('keeps the release, the sizes, and the hashes from the pin list', () => {
    assert.equal(PIPER_RELEASE, '2023.11.14-2');
    assert.equal(PIPER_BINARY.bytes, 26_460_462);
    assert.equal(
      PIPER_BINARY.sha256,
      'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
    );
    assert.equal(
      PIPER_BINARY.url,
      'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz',
    );
    const high = PIPER_VOICES['en_US-ryan-high'];
    assert.ok(high);
    assert.equal(high.model.bytes, 120_786_792);
    assert.equal(
      high.model.sha256,
      'b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca',
    );
    assert.equal(high.config.bytes, 4_166);
    assert.equal(
      high.config.sha256,
      'c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011',
    );
    assert.equal(high.config.url, `${high.model.url}.json`);
    const medium = PIPER_VOICES['en_US-ryan-medium'];
    assert.ok(medium);
    assert.equal(medium.model.bytes, 63_201_294);
    assert.equal(
      medium.model.sha256,
      'abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a',
    );
    assert.equal(medium.config.bytes, 4_883);
    const alan = PIPER_VOICES['en_GB-alan-medium'];
    assert.ok(alan);
    assert.equal(alan.model.bytes, 63_201_294);
    assert.equal(
      alan.model.sha256,
      '0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330',
    );
    assert.equal(alan.config.bytes, 4_888);
    assert.equal(
      alan.config.sha256,
      'c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e',
    );
    assert.equal(DEFAULT_PIPER_VOICE, 'en_US-ryan-high');
    assert.equal(DEFAULT_PIPER_JINGLE_VOICE, 'en_GB-alan-medium');
  });
});

describe('tar reader', () => {
  it('reads a prefix, a mode, and rejects a bad checksum', () => {
    const block = headerFor({
      name: 'phontab',
      prefix: 'piper/espeak-ng-data',
      mode: 0o640,
      size: 2,
      type: '0',
    });
    const header = parseTarHeader(block);
    assert.equal(header?.path, 'piper/espeak-ng-data/phontab');
    assert.equal(header?.mode, 0o640);
    assert.equal(header?.type, 'file');
    block[0] = block[0]! ^ 0xff;
    assert.throws(() => parseTarHeader(block), /checksum/);
  });

  it('unpacks files, directories, a symlink, and a symlink that has to be copied', async () => {
    const dest = await tempDir();
    const links: [string, string][] = [];
    try {
      const archive = tarGz([
        metaEntry({ name: 'piper', type: '5', mode: 0o755 }),
        fileEntry('piper/piper', Buffer.from('bin'), 0o755),
        fileEntry('phontab', Buffer.from('hi'), 0o644, 'piper/espeak-ng-data'),
        fileEntry('piper/real.txt', Buffer.from('hello')),
        metaEntry({ name: 'piper/link.txt', type: '2', linkname: 'real.txt' }),
        metaEntry({ name: 'piper/copy.txt', type: '2', linkname: 'real.txt' }),
      ]);
      await extractTarGz(archive, dest, {
        symlink: async (target, path) => {
          if (path.endsWith('copy.txt')) throw new Error('EPERM');
          links.push([target, path]);
        },
      });
      assert.equal(await readFile(join(dest, 'piper', 'piper'), 'utf8'), 'bin');
      const prefixed = await readFile(join(dest, 'piper', 'espeak-ng-data', 'phontab'), 'utf8');
      assert.equal(prefixed, 'hi');
      const dir = await stat(join(dest, 'piper'));
      assert.equal(dir.isDirectory(), true);
      assert.deepEqual(links, [['real.txt', join(dest, 'piper', 'link.txt')]]);
      assert.equal(await readFile(join(dest, 'piper', 'copy.txt'), 'utf8'), 'hello');
      if (process.platform !== 'win32') {
        const mode = (await stat(join(dest, 'piper', 'piper'))).mode & 0o777;
        assert.equal(mode, 0o755);
      }
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });

  it('rejects a path that climbs out and an absolute path', async () => {
    const dest = await tempDir();
    const evil = `piper-evil-${process.pid}.txt`;
    const outside = join(dest, '..', evil);
    try {
      const climb = tarGz([fileEntry(`../${evil}`, Buffer.from('pwned'))]);
      await assert.rejects(() => extractTarGz(climb, dest), /not safe/);
      assert.equal(existsSync(outside), false);

      const abs = tarGz([headerFor({ name: '/tmp/piper-abs.txt', size: 0, type: '0' })]);
      await assert.rejects(() => extractTarGz(abs, dest), /not safe/);
      assert.equal(existsSync(join(dest, 'tmp', 'piper-abs.txt')), false);
    } finally {
      await rm(dest, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('rejects a symlink that points outside the folder', async () => {
    const dest = await tempDir();
    try {
      const archive = tarGz([
        fileEntry('piper/real.txt', Buffer.from('hello')),
        metaEntry({ name: 'piper/escape.txt', type: '2', linkname: '../../outside.txt' }),
      ]);
      await assert.rejects(() => extractTarGz(archive, dest), /escapes/);
      assert.equal(existsSync(join(dest, 'piper', 'escape.txt')), false);
      assert.equal(existsSync(join(dest, '..', '..', 'outside.txt')), false);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});

describe('installPiper', () => {
  it('checks the hash, retries a dropped download, and skips a second install', async () => {
    const root = await tempDir();
    const { catalog, files } = fixture();
    const calls: string[] = [];
    const waits: number[] = [];
    const { infos } = logs();
    try {
      const outcome = await installPiper({
        root,
        voices: ['en_US-ryan-high', 'en_GB-alan-medium'],
        catalog,
        fetch: fakeFetch(files, calls, { failFirst: catalog.binary.url }),
        platform: 'linux',
        arch: 'x64',
        wait: async (ms) => {
          waits.push(ms);
        },
        now: (() => {
          let t = 0;
          return () => {
            const value = t;
            t += 1_000;
            return value;
          };
        })(),
        log: (message) => infos.push(message),
      });
      assert.equal(outcome.ok, true);
      assert.equal(outcome.skipped, false);
      assert.deepEqual(waits, [1_000]);
      assert.equal(calls.filter((url) => url === catalog.binary.url).length, 2);
      assert.equal(
        calls.some((url) => url.includes('ryan-medium')),
        false,
      );
      assert.equal(
        await readFile(join(root, 'bin', 'test-release', 'piper', 'piper'), 'utf8'),
        'bin',
      );
      const marker = JSON.parse(await readFile(join(root, 'installed.json'), 'utf8')) as {
        release: string;
        voices: string[];
      };
      assert.equal(marker.release, 'test-release');
      assert.deepEqual(marker.voices, ['en_GB-alan-medium', 'en_US-ryan-high']);
      assert.ok(infos.some((line) => line.startsWith('Piper: downloading en_US-ryan-high (')));
      assert.ok(infos.some((line) => /^Piper: installed test-release in \d+\.\d s$/.test(line)));

      const again: string[] = [];
      const second = await installPiper({
        root,
        voices: ['en_US-ryan-high', 'en_GB-alan-medium'],
        catalog,
        fetch: fakeFetch(files, again),
        platform: 'linux',
        arch: 'x64',
        wait: async () => {},
        log: () => {},
      });
      assert.equal(second.skipped, true);
      assert.deepEqual(again, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not keep a file whose hash does not match', async () => {
    const root = await tempDir();
    const { catalog, files } = fixture();
    const calls: string[] = [];
    const waits: number[] = [];
    try {
      const outcome = await installPiper({
        root,
        voices: ['en_US-ryan-high'],
        catalog,
        fetch: fakeFetch(files, calls, { wrong: catalog.binary.url }),
        platform: 'linux',
        arch: 'x64',
        wait: async (ms) => {
          waits.push(ms);
        },
        log: () => {},
      });
      assert.equal(outcome.ok, false);
      assert.match(outcome.reason, /hash does not match/);
      assert.equal(outcome.retry, true);
      assert.deepEqual(waits, [1_000, 2_000]);
      assert.equal(calls.filter((url) => url === catalog.binary.url).length, 3);
      assert.equal(existsSync(join(root, 'installed.json')), false);
      assert.equal(existsSync(join(root, 'bin', 'test-release', 'piper', 'piper')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not download on a platform other than linux/x64', async () => {
    const root = await tempDir();
    let fetched = false;
    try {
      const outcome = await installPiper({
        root,
        voices: ['en_US-ryan-high'],
        fetch: (async () => {
          fetched = true;
          throw new Error('fetched');
        }) as typeof fetch,
        platform: 'win32',
        arch: 'x64',
      });
      assert.equal(fetched, false);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.reason, 'win32/x64');
      assert.equal(outcome.retry, false);
      assert.equal(existsSync(join(root, 'installed.json')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PiperVoice', () => {
  const binary = join('opt', 'piper', 'piper');
  const model = join('voices', 'en_US-ryan-high.onnx');
  const configPath = join('voices', 'en_US-ryan-high.onnx.json');
  const espeak = join('opt', 'piper', 'espeak-ng-data');

  function voice(options: {
    spawn: PiperSpawn;
    resample?: (raw: Buffer) => Promise<Buffer>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    queue?: PiperQueue;
    setPriority?: (pid: number, priority: number) => void;
    lengthScale?: number;
    logger?: Logger;
  }): PiperVoice {
    const { logger } = logs();
    return new PiperVoice({
      voiceName: 'en_US-ryan-high',
      binary,
      model,
      configPath,
      espeakData: espeak,
      lengthScale: options.lengthScale ?? 1,
      sampleRate: 22_050,
      logger: options.logger ?? logger,
      spawn: options.spawn,
      resample: options.resample,
      now: options.now,
      wait: options.wait,
      queue: options.queue,
      setPriority: options.setPriority,
    });
  }

  it('speaks one line, levels it to about -24 dBFS, and logs the speed', async () => {
    const { infos, logger } = logs();
    let seenArgs: readonly string[] = [];
    let seenEnv = '';
    let priority: [number, number] | null = null;
    const raw = speechRaw();
    // A closed-over `let` is narrowed to its initial null, so the buffer lives on an object.
    const heard: { pcm: Buffer | null } = { pcm: null };
    let time = 0;
    let stdinText = '';
    const timed = voice({
      logger,
      lengthScale: 0.8,
      now: () => time,
      setPriority: (pid, value) => {
        priority = [pid, value];
        throw new Error('denied');
      },
      spawn: (command, args, env) => {
        assert.equal(command, binary);
        seenArgs = args;
        seenEnv = env.LD_LIBRARY_PATH ?? '';
        const child = new FakeChild();
        child.onStdin = () => {
          stdinText = child.stdinText;
          time = 1_400;
          child.pushStdout(raw);
          child.emitClose(0, null);
        };
        return asSpawned(child);
      },
      resample: async (pcm) => {
        heard.pcm = pcm;
        return tone(4_800, 8_000);
      },
    });
    const pcm = await timed.speak('Hello 🎧\n  there');
    assert.ok(pcm);
    assert.ok(Math.abs(pcmLoudness(pcm) + 24) < 0.5, String(pcmLoudness(pcm)));
    const resampled = heard.pcm;
    assert.ok(resampled);
    assert.equal(resampled.length, raw.length);
    assert.equal(
      infos.find((line) => line.startsWith('Kitchen FM voice: Piper')),
      'Kitchen FM voice: Piper 1.4 s for 6.2 s of speech (x0.23, en_US-ryan-high)',
    );
    assert.deepEqual(priority, [4242, 10]);
    assert.equal(seenEnv.split(':')[0], join('opt', 'piper'));
    assert.deepEqual(seenArgs, [
      '--model',
      model,
      '--config',
      configPath,
      '--output-raw',
      '--espeak_data',
      espeak,
      '--length_scale',
      '0.8',
      '-q',
    ]);
    assert.equal(timed.speed()?.toFixed(2), '0.23');
    assert.equal(stdinText, 'Hello there\n');
  });

  it('treats a silent clip as a miss and does not spawn for an empty line', async () => {
    let spawned = 0;
    const quiet = voice({
      spawn: () => {
        spawned += 1;
        const child = new FakeChild();
        child.onStdin = () => {
          child.pushStdout(Buffer.from([0, 0]));
          child.emitClose(0, null);
        };
        return asSpawned(child);
      },
      resample: async () => Buffer.alloc(4_800),
    });
    assert.equal(await quiet.speak('Hello'), null);
    assert.equal(quiet.lastMiss(), 'The DJ clip is silent.');
    assert.ok(pcmLoudness(Buffer.alloc(4_800)) < MIN_LOUDNESS_DB);
    assert.equal(await quiet.speak('🎧'), null);
    assert.equal(quiet.lastMiss(), 'The line is empty.');
    assert.equal(spawned, 1);
  });

  it('runs one Piper process at a time, and a spent budget does not start the next', async () => {
    const queue = new PiperQueue();
    const releases: (() => void)[] = [];
    let spawned = 0;
    let time = 0;
    const shared = {
      queue,
      now: () => time,
      spawn: () => {
        spawned += 1;
        const child = new FakeChild();
        child.onStdin = () => {
          releases.push(() => {
            child.pushStdout(speechRaw());
            child.emitClose(0, null);
          });
        };
        return asSpawned(child);
      },
      resample: async () => tone(4_800, 8_000),
    };
    const first = voice({ ...shared, queue });
    const second = voice({ ...shared, queue });
    const a = first.speak('one', 10_000);
    await ticks();
    assert.equal(spawned, 1);
    time = 5_000;
    const b = second.speak('two', 1_000);
    await ticks();
    assert.equal(spawned, 1);
    time = 7_000;
    releases[0]?.();
    assert.ok(await a);
    assert.equal(await b, null);
    assert.equal(second.lastMiss(), 'the time budget ran out');
    assert.equal(spawned, 1);
  });

  it('kills a child that is still going when the budget runs out', async () => {
    let time = 0;
    const waits: number[] = [];
    const gate: { open: (() => void) | null } = { open: null };
    const child = new FakeChild();
    const slow = voice({
      now: () => time,
      wait: (ms) => {
        waits.push(ms);
        return new Promise<void>((resolve) => {
          gate.open = () => resolve();
        });
      },
      spawn: () => asSpawned(child),
      resample: async () => tone(4_800, 8_000),
    });
    const pending = slow.speak('Hello', 1_000);
    await ticks();
    assert.deepEqual(waits, [1_000]);
    time = 1_000;
    gate.open?.();
    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
    ]);
    assert.equal(result, null);
    assert.equal(child.killed, true);
    assert.equal(slow.lastMiss(), 'the time budget ran out');
  });
});

describe('ChainVoice', () => {
  it('uses Piper, then Edge when Piper misses, and Edge while Piper is not ready', async () => {
    const { infos, logger } = logs();
    let time = 0;
    const raw = speechRaw();
    const piper = new PiperVoice({
      voiceName: 'en_US-ryan-high',
      binary: 'piper',
      model: 'model',
      configPath: 'model.json',
      espeakData: 'espeak',
      lengthScale: 1,
      sampleRate: 22_050,
      logger,
      now: () => time,
      spawn: () => {
        const child = new FakeChild();
        child.onStdin = () => {
          time = 1_400;
          child.pushStdout(raw);
          child.emitClose(0, null);
        };
        return asSpawned(child);
      },
      resample: async () => tone(4_800, 8_000),
    });
    const edgeCalls: { text: string; budget: number }[] = [];
    const edge = {
      speak: async (text: string, budgetMs = 0) => {
        edgeCalls.push({ text, budget: budgetMs });
        return Buffer.from('edge');
      },
    };
    let ready = true;
    const chain = new ChainVoice({
      piper: () => (ready ? piper : null),
      edge,
      logger,
      now: () => time,
      fallback: () => (ready ? '' : 'installing'),
      ready: () => Promise.resolve(),
    });
    const clip = await chain.speak('On the hour.');
    assert.ok(clip);
    assert.equal(edgeCalls.length, 0);
    assert.equal(chain.status(), 'Piper en_US-ryan-high, last line x0.23');

    time = 0;
    const miss = new PiperVoice({
      voiceName: 'en_US-ryan-high',
      binary: 'piper',
      model: 'model',
      configPath: 'model.json',
      espeakData: 'espeak',
      lengthScale: 1,
      sampleRate: 22_050,
      logger,
      now: () => time,
      spawn: () => {
        const child = new FakeChild();
        child.onStdin = () => {
          time = 2_500;
          child.pushStderr('broken pipe\n');
          child.emitClose(1, null);
        };
        return asSpawned(child);
      },
    });
    const fallback = new ChainVoice({
      piper: () => miss,
      edge,
      logger,
      now: () => time,
      fallback: () => '',
      ready: () => Promise.resolve(),
    });
    const edged = await fallback.speak('Again.', 20_000);
    assert.equal(edged?.toString(), 'edge');
    assert.equal(edgeCalls.at(-1)?.text, 'Again.');
    assert.equal(edgeCalls.at(-1)?.budget, 17_500);
    assert.ok(
      infos.some(
        (line) => line === 'Kitchen FM voice: Piper miss after 2.5 s: broken pipe, using Edge',
      ),
    );

    ready = false;
    const early = await chain.speak('Live while installing.');
    assert.equal(early?.toString(), 'edge');
    assert.equal(edgeCalls.at(-1)?.text, 'Live while installing.');
    assert.equal(chain.status(), 'Edge (Piper installing)');
  });

  it('speaks Czech with Edge and does not install Piper', async () => {
    const { infos, warns, logger } = logs();
    let fetched = false;
    const edge = {
      speak: async (text: string) => Buffer.from(`edge:${text}`),
    };
    const voices = openKitchenVoices(
      {
        language: 'cs',
        engine: 'piper',
        voice: 'cs-CZ-VlastaNeural',
        jingleVoice: 'en-GB-RyanNeural',
        piperVoice: 'en_US-ryan-high',
        piperJingleVoice: 'en_GB-alan-medium',
        piperLengthScale: 1,
      },
      logger,
      {
        edge,
        jingleEdge: edge,
        fetch: (async () => {
          fetched = true;
          throw new Error('fetched');
        }) as typeof fetch,
      },
    );
    try {
      const pcm = await voices.dj.speak('Ahoj');
      assert.equal(pcm?.toString(), 'edge:Ahoj');
      assert.equal(fetched, false);
      assert.ok(infos.some((line) => line === 'Piper: not used for Czech; Edge speaks.'));
      assert.equal(voices.dj.status(), 'Edge (Piper unavailable: no Czech voice)');
      assert.equal(warns.length, 0);
    } finally {
      voices.stop();
    }
  });
});

describe('openKitchenVoices', () => {
  it('installs, smokes, and then speaks, and Edge covers the line until then', async () => {
    const root = await tempDir();
    const { catalog, files } = fixture();
    const { infos, logger } = logs();
    const edgeTexts: string[] = [];
    const held: { fn: (() => void) | null } = { fn: null };
    let smokes = 0;
    let voices: ReturnType<typeof openKitchenVoices> | null = null;
    try {
      voices = openKitchenVoices(
        {
          language: 'en',
          engine: 'piper',
          voice: 'en-US-AndrewMultilingualNeural',
          jingleVoice: 'en-GB-RyanNeural',
          piperVoice: 'en_US-ryan-high',
          piperJingleVoice: 'en_GB-alan-medium',
          piperLengthScale: 1,
        },
        logger,
        {
          root,
          catalog,
          platform: 'linux',
          arch: 'x64',
          fetch: fakeFetch(files, []),
          wait: async () => {},
          edge: {
            speak: async (text) => {
              edgeTexts.push(text);
              return Buffer.from('edge');
            },
          },
          jingleEdge: { speak: async () => Buffer.from('jingle') },
          spawn: () => {
            smokes += 1;
            const child = new FakeChild();
            child.onStdin = () => {
              held.fn = () => {
                child.pushStdout(speechRaw());
                child.emitClose(0, null);
              };
            };
            return asSpawned(child);
          },
          resample: async () => tone(4_800, 8_000),
        },
      );
      // The install is a chain of file writes. Wait until the check line is
      // actually held, or releasing it early leaves the smoke test waiting.
      const deadline = Date.now() + 3_000;
      while (held.fn === null && Date.now() < deadline) await later();
      const hold = held.fn;
      assert.ok(hold, `${voices.dj.status()} | ${infos.join(' | ')}`);
      assert.equal(voices.dj.status(), 'Edge (Piper installing)');
      const early = await voices.dj.speak('Live.');
      assert.equal(early?.toString(), 'edge');
      assert.deepEqual(edgeTexts, ['Live.']);
      hold();
      await voices.dj.ready();
      assert.match(voices.dj.status(), /^Piper en_US-ryan-high, last line x/);
      assert.ok(
        infos.some((line) => line.startsWith('Piper ready: en_US-ryan-high, check line x')),
      );
      assert.equal(smokes, 1);
    } finally {
      voices?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries a failed smoke test an hour later', async () => {
    const root = await tempDir();
    const { catalog, files } = fixture();
    const { warns, logger } = logs();
    const scheduledBox: { current: { fn: () => void; ms: number } | null } = { current: null };
    let attempt = 0;
    let voices: ReturnType<typeof openKitchenVoices> | null = null;
    try {
      voices = openKitchenVoices(
        {
          language: 'en',
          engine: 'piper',
          voice: 'en-US-AndrewMultilingualNeural',
          jingleVoice: 'en-GB-RyanNeural',
          piperVoice: 'en_US-ryan-high',
          piperJingleVoice: 'en_GB-alan-medium',
          piperLengthScale: 1,
        },
        logger,
        {
          root,
          catalog,
          platform: 'linux',
          arch: 'x64',
          maxAttempts: 2,
          fetch: fakeFetch(files, []),
          wait: async () => {},
          edge: { speak: async () => Buffer.from('edge') },
          jingleEdge: { speak: async () => null },
          schedule: (fn, ms) => {
            scheduledBox.current = { fn, ms };
            return {
              clear() {
                scheduledBox.current = null;
              },
            };
          },
          spawn: () => {
            attempt += 1;
            const child = new FakeChild();
            const which = attempt;
            child.onStdin = () => {
              if (which === 1) {
                child.pushStderr('glibc missing\n');
                child.emitClose(1, null);
                return;
              }
              child.pushStdout(speechRaw());
              child.emitClose(0, null);
            };
            return asSpawned(child);
          },
          resample: async () => tone(4_800, 8_000),
        },
      );
      await voices.dj.ready();
      assert.equal(voices.dj.status(), 'Edge (Piper unavailable: glibc missing)');
      assert.ok(warns.some((line) => line === 'Piper unavailable: glibc missing'));
      const scheduled = scheduledBox.current;
      assert.equal(scheduled?.ms, 60 * 60_000);
      assert.ok(scheduled);
      scheduled.fn();
      const deadline = Date.now() + 3_000;
      while (!voices.dj.status().startsWith('Piper ') && Date.now() < deadline) await later();
      assert.match(voices.dj.status(), /^Piper en_US-ryan-high/);
    } finally {
      voices?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips the install when a binary path is given', async () => {
    const root = await tempDir();
    const { logger } = logs();
    let fetched = false;
    try {
      const voicesDir = join(root, 'voices');
      await mkdir(voicesDir, { recursive: true });
      const json = '{"audio":{"sample_rate":22050}}';
      await writeFile(join(voicesDir, 'en_US-ryan-high.onnx'), 'model');
      await writeFile(join(voicesDir, 'en_US-ryan-high.onnx.json'), json);
      await writeFile(join(voicesDir, 'en_GB-alan-medium.onnx'), 'model');
      await writeFile(join(voicesDir, 'en_GB-alan-medium.onnx.json'), json);
      const voices = openKitchenVoices(
        {
          language: 'en',
          engine: 'piper',
          voice: 'en-US-AndrewMultilingualNeural',
          jingleVoice: 'en-GB-RyanNeural',
          piperVoice: 'en_US-ryan-high',
          piperJingleVoice: 'en_GB-alan-medium',
          piperLengthScale: 1,
        },
        logger,
        {
          binaryPath: join(root, 'piper.exe'),
          espeakData: join(root, 'espeak-ng-data'),
          voicesDir,
          fetch: (async () => {
            fetched = true;
            throw new Error('fetched');
          }) as typeof fetch,
          edge: { speak: async () => null },
          jingleEdge: { speak: async () => null },
          spawn: () => {
            const child = new FakeChild();
            child.onStdin = () => {
              child.pushStdout(speechRaw());
              child.emitClose(0, null);
            };
            return asSpawned(child);
          },
          resample: async () => tone(4_800, 8_000),
        },
      );
      await voices.dj.ready();
      assert.equal(fetched, false);
      assert.match(voices.dj.status(), /^Piper en_US-ryan-high/);
      voices.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('voice identity and config', () => {
  it('reads the sample rate and waits for a speaker', async () => {
    assert.equal(sampleRateOf('{"audio":{"sample_rate":22050}}'), 22_050);
    assert.throws(() => sampleRateOf('{}'), /sample rate/);
    const started = Date.now();
    await waitForReady({ ready: () => new Promise(() => {}) }, 40);
    assert.ok(Date.now() - started < 1_000);
    let settled = false;
    await waitForReady(
      {
        ready: () => {
          settled = true;
          return Promise.resolve();
        },
      },
      60_000,
    );
    assert.equal(settled, true);
  });

  it('names a Piper voice, and keeps the Edge name otherwise', () => {
    assert.equal(
      djVoiceIdentity({
        language: 'en',
        engine: 'piper',
        voice: 'en-US-AndrewMultilingualNeural',
        piperVoice: 'en_US-ryan-high',
      }),
      'piper:en_US-ryan-high',
    );
    assert.equal(
      djVoiceIdentity({
        language: 'en',
        engine: 'edge',
        voice: 'en-US-AndrewMultilingualNeural',
        piperVoice: 'en_US-ryan-high',
      }),
      'en-US-AndrewMultilingualNeural',
    );
    assert.equal(
      djVoiceIdentity({
        language: 'cs',
        engine: 'piper',
        voice: 'cs-CZ-VlastaNeural',
        piperVoice: 'en_US-ryan-high',
      }),
      'cs-CZ-VlastaNeural',
    );
    assert.equal(
      djVoiceIdentity({ language: 'en', voice: 'en-US-AndrewMultilingualNeural' }),
      'en-US-AndrewMultilingualNeural',
    );
  });

  it('parses Piper settings, defaults, and a bad voice name', () => {
    const base = {
      discord: { clientId: '1' },
      steam: { cron: '0 0 * * *' },
      epic: { cron: '0 0 * * *' },
      embedColor: '#5865F2',
    };
    const warnings: string[] = [];
    const parsed = parseConfig(base, (message) => warnings.push(message));
    assert.equal(parsed.dj.engine, 'piper');
    assert.equal(parsed.dj.piperVoice, 'en_US-ryan-high');
    assert.equal(parsed.dj.piperJingleVoice, 'en_GB-alan-medium');
    assert.equal(parsed.dj.piperLengthScale, 1);
    assert.equal(parsed.dj.voice, 'en-US-AndrewMultilingualNeural');
    assert.equal(warnings.length, 0);

    const tuned = parseConfig(
      {
        ...base,
        dj: {
          engine: 'edge',
          piperVoice: 'nope',
          piperJingleVoice: 'en_US-ryan-medium',
          piperLengthScale: 2,
        },
      },
      (message) => warnings.push(message),
    );
    assert.equal(tuned.dj.engine, 'edge');
    assert.equal(tuned.dj.piperVoice, 'en_US-ryan-high');
    assert.equal(tuned.dj.piperJingleVoice, 'en_US-ryan-medium');
    assert.equal(tuned.dj.piperLengthScale, 1.3);
    assert.ok(warnings.some((line) => line.includes('nope')));

    const slow = parseConfig(
      { ...base, dj: { piperLengthScale: 0.2, engine: 'Piper' } },
      (message) => warnings.push(message),
    );
    assert.equal(slow.dj.piperLengthScale, 0.7);
    assert.equal(slow.dj.engine, 'piper');
    assert.ok(warnings.some((line) => line.includes('Piper')));
  });
});
