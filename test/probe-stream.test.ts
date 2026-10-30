import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { StreamType } from '@discordjs/voice';
import { bufferStream } from '../src/music/buffer-stream';
import { probeStream } from '../src/music/probe-stream';

function collectErrors(stream: Readable): Error[] {
  const errors: Error[] = [];
  stream.on('error', (error: Error) => errors.push(error));
  return errors;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function closeQuietly(stream: Readable | null): void {
  if (stream && !stream.destroyed) stream.destroy();
}

/** One buffer-mode chunk, already ended. Readable.from() would be object mode. */
function chunk(bytes: Buffer): PassThrough {
  const raw = new PassThrough();
  raw.end(bytes);
  return raw;
}

/** Minimal Ogg BOS page with an OpusHead packet. prism's OggDemuxer does not check the CRC. */
function oggOpusHead(extra: Buffer): Buffer {
  const packet = Buffer.alloc(19);
  packet.write('OpusHead', 0, 'ascii');
  packet[8] = 1;
  packet[9] = 2;
  packet.writeUInt32LE(48_000, 12);

  const page = Buffer.alloc(28 + packet.length);
  page.write('OggS', 0, 'ascii');
  page[5] = 2;
  page[26] = 1;
  page[27] = packet.length;
  packet.copy(page, 28);
  return Buffer.concat([page, extra]);
}

describe('probeStream', () => {
  it('keeps a song that was fully prefetched, EOF and all', async () => {
    const total = 4 * 1024 * 1024;
    const chunkSize = 64 * 1024;
    const bytes = Buffer.alloc(total);
    const pattern = Buffer.alloc(256);
    for (let i = 0; i < pattern.length; i++) pattern[i] = i;
    for (let offset = 0; offset < total; offset += pattern.length) pattern.copy(bytes, offset);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < total; offset += chunkSize) {
      parts.push(Buffer.from(bytes.subarray(offset, offset + chunkSize)));
    }
    const raw = Readable.from(parts);
    const buffered = bufferStream(raw, 16 * 1024 * 1024);
    const errors = collectErrors(buffered);
    collectErrors(raw);
    let probed: Readable | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(raw.readableEnded, true);
      assert.equal(buffered.readableEnded, false);
      assert.equal(buffered.readableLength, bytes.length);

      const result = await probeStream(buffered);
      probed = result.stream;
      assert.equal(errors.length, 0);
      assert.equal(buffered.destroyed, false);
      assert.equal(probed.destroyed, false);
      assert.equal(probed, buffered);
      const out = await readAll(probed);
      assert.ok(out.equals(bytes));
    } finally {
      closeQuietly(probed);
      closeQuietly(buffered);
      closeQuietly(raw);
    }
  });

  it('returns 120 buffered chunks in their original order', async () => {
    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    for (let index = 0; index < 120; index++) {
      const chunk = Buffer.alloc(chunkSize, index & 0xff);
      chunk.writeUInt32BE(index, 0);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const raw = Readable.from(chunks);
    const buffered = bufferStream(raw, 2 * 1024 * 1024);
    collectErrors(buffered);
    collectErrors(raw);
    let probed: Readable | null = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(buffered.readableLength, 2 * 1024 * 1024);

      const result = await probeStream(buffered);
      probed = result.stream;
      assert.equal(probed.destroyed, false);
      const out = await readAll(probed);
      assert.ok(out.equals(bytes));
    } finally {
      closeQuietly(probed);
      closeQuietly(buffered);
      closeQuietly(raw);
    }
  });

  it('rejects a stream that has already ended', async () => {
    const raw = new PassThrough();
    collectErrors(raw);
    raw.end(Buffer.from('gone'));
    raw.resume();
    await once(raw, 'end');
    try {
      assert.equal(raw.readableEnded, true);
      await assert.rejects(() => probeStream(raw), /Cannot probe a stream that has ended/);
    } finally {
      closeQuietly(raw);
    }
  });

  it('treats a short stream that ends during the probe as arbitrary', async () => {
    const bytes = Buffer.from('tiny-audio');
    const raw = chunk(bytes);
    collectErrors(raw);
    let probed: Readable | null = null;
    try {
      const result = await probeStream(raw);
      probed = result.stream;
      assert.equal(result.type, StreamType.Arbitrary);
      const out = await readAll(probed);
      assert.ok(out.equals(bytes));
    } finally {
      closeQuietly(probed);
      closeQuietly(raw);
    }
  });

  it('detects an Ogg Opus header and keeps the leading bytes', async () => {
    const bytes = oggOpusHead(Buffer.alloc(64, 0xab));
    const raw = chunk(bytes);
    collectErrors(raw);
    let probed: Readable | null = null;
    try {
      const result = await probeStream(raw);
      probed = result.stream;
      assert.equal(result.type, StreamType.OggOpus);
      assert.equal(probed.destroyed, false);
      const out = await readAll(probed);
      assert.ok(out.equals(bytes));
      assert.ok(out.subarray(0, 4).equals(Buffer.from('OggS')));
    } finally {
      closeQuietly(probed);
      closeQuietly(raw);
    }
  });
});
