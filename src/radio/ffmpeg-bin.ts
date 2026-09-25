import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../core/logger';

/** MP3 on stdin → 48 kHz stereo PCM. FFmpeg must not open the Icecast URL itself. */
export const FFMPEG_MP3_PIPE_ARGS = [
  '-hide_banner',
  '-loglevel',
  'warning',
  '-probesize',
  '32768',
  '-analyzeduration',
  '0',
  '-i',
  'pipe:0',
  '-vn',
  '-f',
  's16le',
  '-ar',
  '48000',
  '-ac',
  '2',
  'pipe:1',
];

const require = createRequire(import.meta.url);

const PROBE_URL = 'https://icecast3.play.cz/radiobeat128.mp3';

const CANARY_ARGS = [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=sample_rate=48000:channel_layout=stereo',
  '-t',
  '0.25',
  '-f',
  's16le',
  '-ar',
  '48000',
  '-ac',
  '2',
  'pipe:1',
];

/**
 * Why the chosen binary could not be proven, shown if radio still fails to start.
 * Empty once a binary has transcoded a short tone.
 */
let problem = '';

export function ffmpegProblem(): string {
  return problem;
}

/**
 * Pick an FFmpeg that can actually transcode on this machine.
 *
 * The bot is developed on Windows and runs in a Linux x64 container on the
 * Mac mini. Every static Linux FFmpeg build SIGSEGV there as soon as it
 * opens an Icecast URL itself. Decoding MP3 that Node already downloaded
 * does not, so playback feeds those bytes on stdin. A candidate has to
 * decode a saved slice of Radio Beat before it is accepted. `FFMPEG_BIN`
 * has to be set before `ffmpeg-static` is imported; that package returns
 * this path to prism-media as well.
 */
function ensureFfmpeg(): void {
  const chosen = pickFfmpeg();
  if (!chosen) {
    problem = `No working FFmpeg on ${process.platform}/${process.arch}.`;
    logger.error(problem);
    return;
  }
  process.env.FFMPEG_BIN = chosen;
  process.env.FFMPEG_PATH = chosen;
  logger.info(`ffmpeg: using ${chosen} (${process.platform}/${process.arch})`);
}

function pickFfmpeg(): string | null {
  const bundled = bundledBinary();
  const legacy = legacyLinuxBinary();
  const candidates = [
    ...systemCandidates(),
    ...(legacy ? [legacy] : []),
    ...(bundled ? [bundled] : []),
  ];
  const sample = downloadSample(PROBE_URL);
  let fallback: string | null = null;
  let sawCrash = false;

  for (const candidate of candidates) {
    const verdict = assess(candidate, sample);
    if (verdict === 'ok') return candidate;
    if (verdict === 'crash') sawCrash = true;
    if (verdict === 'offline') fallback ??= candidate;
  }

  if (sawCrash && installLinuxFfmpeg()) {
    for (const candidate of systemCandidates()) {
      if (assess(candidate, sample) === 'ok') return candidate;
    }
  }

  if (fallback) return fallback;
  if (bundled) {
    problem = `FFmpeg crashed while decoding radio on ${process.platform}/${process.arch}.`;
    return bundled;
  }
  return null;
}

type Verdict = 'ok' | 'crash' | 'offline' | 'unusable';

function assess(command: string, sample: Buffer | null): Verdict {
  const tone = canTranscode(command);
  if (tone !== 'ok') return tone;
  if (!sample) return 'offline';
  return probeMp3(command, sample);
}

function systemCandidates(): string[] {
  const found: string[] = [];
  const fixed = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const path of fixed) {
    if (existsSync(path)) found.push(path);
  }
  const lookedUp = lookUpOnPath('ffmpeg');
  if (lookedUp && !found.includes(lookedUp)) found.push(lookedUp);
  return found;
}

function lookUpOnPath(command: string): string | null {
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(finder, [command], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const line = output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && existsSync(entry));
    return line ?? null;
  } catch {
    return null;
  }
}

function legacyLinuxBinary(): string | null {
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  try {
    const pkgJson = require.resolve('@ffmpeg-installer/linux-x64/package.json');
    const bin = join(dirname(pkgJson), 'ffmpeg');
    if (!existsSync(bin)) return null;
    try {
      chmodSync(bin, 0o755);
    } catch {
      /* the install script may already have done this */
    }
    return bin;
  } catch {
    return null;
  }
}

function bundledBinary(): string | null {
  try {
    const pkgJson = require.resolve('ffmpeg-static/package.json');
    const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const bin = join(dirname(pkgJson), name);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function downloadSample(url: string): Buffer | null {
  const dest = join(tmpdir(), 'dzbanek-radio-sample.mp3');
  const scriptPath = join(tmpdir(), 'dzbanek-radio-sample.cjs');
  writeFileSync(
    scriptPath,
    `
const https = require('https');
const http = require('http');
const fs = require('fs');
const dest = process.argv[2];
const start = process.argv[3];
function get(url, hops) {
  if (hops > 5) process.exit(1);
  const lib = url.startsWith('https:') ? https : http;
  const req = lib.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Dzbanek-bot/2.0)',
      'Icy-MetaData': '0',
    },
  }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      get(new URL(res.headers.location, url).href, hops + 1);
      return;
    }
    if (res.statusCode !== 200) {
      console.error('HTTP ' + res.statusCode);
      process.exit(1);
    }
    const chunks = [];
    let size = 0;
    let wrote = false;
    const finish = () => {
      if (wrote) return;
      wrote = true;
      fs.writeFileSync(dest, Buffer.concat(chunks));
      process.exit(size > 8000 ? 0 : 2);
    };
    res.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= 80000) {
        res.destroy();
        finish();
      }
    });
    res.on('end', finish);
    res.on('error', (error) => {
      console.error(error.message);
      process.exit(1);
    });
  });
  req.on('error', (error) => {
    console.error(error.message);
    process.exit(1);
  });
  req.setTimeout(15000, () => {
    req.destroy();
    process.exit(1);
  });
}
get(start, 0);
`,
  );
  const result = spawnSync(process.execPath, [scriptPath, dest, url], {
    timeout: 20_000,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !existsSync(dest)) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 200);
    logger.warn(
      `ffmpeg: could not sample the station (${detail || result.signal || result.status})`,
    );
    return null;
  }
  const sample = readFileSync(dest);
  return sample.length > 8_000 ? sample : null;
}

function probeMp3(command: string, sample: Buffer): Verdict {
  const args = [...FFMPEG_MP3_PIPE_ARGS];
  args.splice(args.length - 1, 0, '-t', '1');
  const result = spawnSync(command, args, {
    input: sample,
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 1_000_000,
  });
  const bytes = result.stdout?.length ?? 0;
  const stderr = result.stderr?.toString('utf8').trim().slice(0, 300) ?? '';
  if (result.signal) {
    logger.warn(
      `ffmpeg: radio probe crashed ${command} (signal=${result.signal}${stderr ? `, ${stderr}` : ''})`,
    );
    return 'crash';
  }
  if (!result.error && bytes > 8_000) {
    logger.info(`ffmpeg: radio probe ok (${bytes} bytes)`);
    return 'ok';
  }
  logger.warn(
    `ffmpeg: radio probe missed ${command} (status=${result.status ?? 'null'}, bytes=${bytes}${stderr ? `, ${stderr}` : ''})`,
  );
  return 'offline';
}

function canTranscode(command: string): Verdict {
  const result = spawnSync(command, CANARY_ARGS, {
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 2_000_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bytes = result.stdout?.length ?? 0;
  if (!result.error && !result.signal && result.status === 0 && bytes > 1000) return 'ok';
  const stderr = result.stderr?.toString('utf8').trim().slice(0, 300) ?? '';
  logger.warn(
    `ffmpeg: rejected ${command} (status=${result.status ?? 'null'}, signal=${result.signal ?? 'none'}, bytes=${bytes}${stderr ? `, ${stderr}` : ''})`,
  );
  return result.signal ? 'crash' : 'unusable';
}

function installLinuxFfmpeg(): boolean {
  if (process.platform !== 'linux') return false;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    logger.warn('ffmpeg: not running as root, so a system FFmpeg cannot be installed.');
    return false;
  }

  const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  try {
    if (osRelease.includes('ID=alpine') || existsSync('/sbin/apk')) {
      logger.info('ffmpeg: installing the Alpine ffmpeg package.');
      execFileSync('apk', ['add', '--no-cache', 'ffmpeg', 'ca-certificates'], {
        env,
        timeout: 180_000,
        stdio: 'inherit',
      });
      return true;
    }
    if (existsSync('/usr/bin/apt-get')) {
      logger.info('ffmpeg: installing the distro ffmpeg package.');
      execFileSync('apt-get', ['update'], { env, timeout: 180_000, stdio: 'inherit' });
      execFileSync(
        'apt-get',
        ['install', '-y', '--no-install-recommends', 'ffmpeg', 'ca-certificates'],
        { env, timeout: 180_000, stdio: 'inherit' },
      );
      return true;
    }
  } catch (error) {
    logger.error('ffmpeg: system install failed:', error);
  }
  return false;
}

ensureFfmpeg();
