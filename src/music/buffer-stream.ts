import { PassThrough, type Readable } from 'node:stream';

const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024;

/**
 * Buffer an audio source (yt-dlp stdout). `bytes` is how much it holds before
 * the source blocks. Destroying the buffer also destroys the source, which
 * closes stdout and kills yt-dlp. A bare pipe() only unpipes, leaving yt-dlp
 * blocked on a full pipe forever.
 */
export function bufferStream(raw: Readable, bytes = DEFAULT_BUFFER_BYTES): PassThrough {
  const buffered = new PassThrough({ highWaterMark: bytes });
  raw.once('error', (error) => buffered.destroy(error));
  buffered.once('close', () => {
    if (!raw.destroyed) raw.destroy();
  });
  raw.pipe(buffered);
  return buffered;
}
