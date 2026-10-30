import { StreamType, validateDiscordOpusHead } from '@discordjs/voice';
import { Readable } from 'node:stream';
import prism from 'prism-media';

/**
 * Probe a readable for Opus in WebM or Ogg.
 * demuxProbe puts the bytes it read back with push(), which breaks a prefetched
 * stream: those bytes land after data already buffered, and push() throws once
 * that stream has hit EOF. unshift() puts them back at the front.
 */
export function probeStream(
  stream: Readable,
  probeSize = 1024,
): Promise<{ stream: Readable; type: StreamType }> {
  return new Promise((resolve, reject) => {
    if (stream.readableObjectMode) {
      reject(new Error('Cannot probe a readable stream in object mode'));
      return;
    }
    if (stream.readableEnded) {
      reject(new Error('Cannot probe a stream that has ended'));
      return;
    }

    let readBuffer = Buffer.alloc(0);
    let settled = false;
    const webm = new prism.opus.WebmDemuxer();
    const ogg = new prism.opus.OggDemuxer();

    const ignoreDemuxerError = (): void => {};
    // A demuxer that does not recognize the bytes emits 'error' and destroys
    // itself. That is not a failure of the probe; the other demuxer may match.
    webm.on('error', ignoreDemuxerError);
    ogg.on('error', ignoreDemuxerError);

    const dropDemuxers = (): void => {
      process.nextTick(() => {
        webm.destroy();
        ogg.destroy();
      });
    };

    // The 'error' listener stays, as in demuxProbe: the stream can wait through a
    // DJ intro before the player listens, and an unheard error would crash the bot.
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('close', onClose);
      stream.off('end', onClose);
      stream.pause();
    };

    const finish = (type: StreamType): void => {
      if (settled) return;
      settled = true;
      const ended = stream.readableEnded;
      cleanup();
      dropDemuxers();
      if (ended) {
        // Readable.from iterates a bare Buffer one byte at a time.
        resolve({ stream: Readable.from([readBuffer]), type });
        return;
      }
      if (readBuffer.length > 0) {
        try {
          stream.unshift(readBuffer);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      resolve({ stream, type });
    };

    const onClose = (): void => {
      if (!settled) finish(StreamType.Arbitrary);
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      readBuffer = Buffer.concat([readBuffer, chunk]);
      if (!webm.destroyed) webm.write(chunk);
      if (settled) return;
      if (!ogg.destroyed) ogg.write(chunk);
      if (settled) return;
      if (readBuffer.length >= probeSize) {
        stream.off('data', onData);
        stream.pause();
        process.nextTick(onClose);
      }
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      dropDemuxers();
      reject(error);
    };

    webm.on('head', (head: Buffer) => {
      if (validateDiscordOpusHead(head)) finish(StreamType.WebmOpus);
    });
    ogg.on('head', (head: Buffer) => {
      if (validateDiscordOpusHead(head)) finish(StreamType.OggOpus);
    });

    stream.on('data', onData);
    stream.once('close', onClose);
    stream.once('end', onClose);
    stream.once('error', onError);
  });
}
