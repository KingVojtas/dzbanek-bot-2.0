import { PassThrough, type Readable } from 'node:stream';

const BUFFER_BYTES = 2 * 1024 * 1024;

/**
 * Buffer an audio source (yt-dlp stdout). Destroying the buffer also destroys
 * the source, which closes stdout and kills yt-dlp. A bare pipe() only
 * unpipes, leaving yt-dlp blocked on a full pipe forever.
 */
export function bufferStream(raw: Readable): PassThrough {
  const buffered = new PassThrough({ highWaterMark: BUFFER_BYTES });
  raw.once('error', (error) => buffered.destroy(error));
  buffered.once('close', () => {
    if (!raw.destroyed) raw.destroy();
  });
  raw.pipe(buffered);
  return buffered;
}
