import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { FFMPEG_MP3_PIPE_ARGS } from './ffmpeg-bin';

const STDERR_CAP = 4_000;

export interface IcecastDecoder {
  stdout: Readable;
  /** Latest FFmpeg stderr, trimmed and capped. */
  stderr(): string;
  /** Set when FFmpeg exits on its own with an error or a crash signal. */
  failure(): string;
  stop(): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Decode one Icecast MP3 to 48 kHz stereo PCM.
 *
 * On the Mac mini's Linux container, FFmpeg SIGSEGV as soon as it opens the
 * station URL itself. Node fetches the stream and FFmpeg only decodes the
 * bytes on stdin. `-nostdin` would make it ignore that audio, so it is not set.
 */
export function openIcecastDecoder(url: string): IcecastDecoder {
  const command = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const child: ChildProcess = spawn(command, FFMPEG_MP3_PIPE_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (!child.stdout || !child.stderr || !child.stdin) {
    child.kill('SIGKILL');
    throw new Error('FFmpeg did not expose stdin, stdout, and stderr pipes.');
  }

  const feed = pipeStation(url, child.stdin);

  const stdout = child.stdout;
  const stderr = child.stderr;
  let stderrBuf = '';
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_CAP);
  });
  stderr.on('error', () => {
    /* closed when the process is killed */
  });

  let failure = '';
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      if (signal && signal !== 'SIGKILL') {
        failure = `FFmpeg crashed (${signal}).`;
      } else if (code && code !== 0) {
        const detail = stderrBuf.trim();
        failure = `FFmpeg exited ${code}${detail ? `: ${detail.slice(0, 300)}` : '.'}`;
      }
      resolve({ code, signal });
    });
  });

  child.once('error', (error) => {
    stdout.destroy(error);
  });
  stdout.on('error', () => {
    /* the player reports a failed resource itself */
  });

  return {
    stdout,
    stderr: () => stderrBuf.trim(),
    failure: () => failure,
    stop() {
      feed.stop();
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    },
    exited,
  };
}

function pipeStation(url: string, stdin: Writable): { stop: () => void } {
  let req: ClientRequest | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    req?.destroy();
    stdin.destroy();
  };

  const open = (current: string, hops: number) => {
    if (stopped || hops > 5) return;
    const request = current.startsWith('https:') ? httpsRequest : httpRequest;
    req = request(
      current,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Dzbanek-bot/2.0)',
          'Icy-MetaData': '0',
        },
      },
      (res) => {
        const location = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume();
          open(new URL(location, current).toString(), hops + 1);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          stdin.destroy(new Error(`Icecast responded HTTP ${res.statusCode ?? '?'}`));
          return;
        }
        res.on('error', (error) => stdin.destroy(error));
        res.pipe(stdin);
      },
    );
    req.on('error', (error) => {
      if (!stopped) stdin.destroy(error);
    });
    req.end();
  };

  open(url, 0);
  return { stop };
}
