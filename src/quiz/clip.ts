import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Track } from '../core/types';
import type { CompositeTrackSource } from '../music/sources';
import { QUIZ_CLIP_SEC, clipStart, type QuizSong } from './songs';

/** 48 kHz stereo s16le: what `StreamType.Raw` expects. */
const BYTES_PER_SEC = 48_000 * 2 * 2;
const MIN_CLIP_SEC = 6;
const CLIP_TIMEOUT_MS = 45_000;

export interface QuizClip {
  song: QuizSong;
  pcm: Buffer;
}

/** Find a radio catch on YouTube. The song gets its url, length, and art. */
async function locate(song: QuizSong, source: CompositeTrackSource): Promise<QuizSong> {
  if (song.url) return song;
  const hit = await source.youtube.searchOne(song.query, 'Kitchen Quiz');
  if (!hit) throw new Error(`No YouTube match for "${song.query}".`);
  return {
    ...song,
    url: hit.url,
    durationSec: hit.durationSec,
    thumbnail: song.thumbnail ?? hit.thumbnail,
  };
}

/**
 * Cut a 15 s clip into memory. FFmpeg never opens a URL: on the Mac mini that
 * crashes it, so yt-dlp's audio arrives on stdin, as radio's does. The clip is
 * trimmed in the filter, evened out in loudness, and faded at both ends.
 */
export async function prepareClip(song: QuizSong, source: CompositeTrackSource): Promise<QuizClip> {
  const found = await locate(song, source);
  const track: Track = {
    title: found.title,
    url: found.url!,
    durationSec: found.durationSec,
    requestedBy: 'Kitchen Quiz',
  };
  const input = await source.stream(track);
  const start = clipStart(found.durationSec);
  const fadeOut = QUIZ_CLIP_SEC - 1.5;
  const pcm = await decode(input, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-vn',
    '-af',
    `atrim=start=${start},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,` +
      `afade=t=in:d=0.6,afade=t=out:st=${fadeOut}:d=1.5`,
    '-t',
    String(QUIZ_CLIP_SEC),
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1',
  ]);
  if (pcm.length < MIN_CLIP_SEC * BYTES_PER_SEC) {
    throw new Error(`Clip of "${found.label}" came out too short.`);
  }
  return { song: found, pcm };
}

function decode(input: Readable, args: string[]): Promise<Buffer> {
  const command = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error('Clip took too long.')), CLIP_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000);
    });
    // FFmpeg stops reading once the clip is long enough; the rest of the song is not needed.
    child.stdin.on('error', () => {});
    input.on('error', () => child.stdin.end());
    input.pipe(child.stdin);

    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (total > 0) finish(null);
      else finish(new Error(`FFmpeg exited ${code ?? '?'}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}
