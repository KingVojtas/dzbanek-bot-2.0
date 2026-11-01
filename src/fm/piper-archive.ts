import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, open, symlink as fsSymlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** ustar header. Piper's tarball is ustar, including the `prefix` field. */
const BLOCK = 512;
/** A single entry bigger than this is not the Piper release. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** The real archive has 406 entries. More than this is not it. */
const MAX_ENTRIES = 5_000;

/** One ustar header. `path` is `prefix/name` when the prefix is set. */
export interface TarHeader {
  path: string;
  mode: number;
  size: number;
  type: 'file' | 'dir' | 'symlink';
  linkname: string;
}

/**
 * Read one ustar header. Null is the zero block that ends the archive.
 * Throws when the checksum, magic, or entry type is not one Piper uses.
 */
export function parseTarHeader(block: Buffer): TarHeader | null {
  if (block.length !== BLOCK) throw new Error('Piper archive header is short.');
  if (block.every((byte) => byte === 0)) return null;
  const magic = block.toString('ascii', 257, 262);
  if (magic !== 'ustar') throw new Error('Piper archive is not ustar.');
  const stored = readOctal(block, 148, 8);
  if (stored !== headerChecksum(block)) {
    throw new Error('Piper archive header checksum does not match.');
  }
  const name = readField(block, 0, 100);
  const prefix = readField(block, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  const flag = block[156] ?? 0;
  const type =
    flag === 0 || flag === 48 ? 'file' : flag === 53 ? 'dir' : flag === 50 ? 'symlink' : '';
  if (type !== 'file' && type !== 'dir' && type !== 'symlink') {
    throw new Error(`Piper archive has an unsupported entry (${flag} ${path}).`);
  }
  const size = readOctal(block, 124, 12);
  if (size > MAX_ENTRY_BYTES) throw new Error(`Piper archive entry is too large: ${path}`);
  return {
    path,
    mode: readOctal(block, 100, 8) & 0o777,
    size,
    type,
    linkname: readField(block, 157, 100),
  };
}

/** Sum of the header with the checksum field treated as spaces, the ustar rule. */
function headerChecksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  }
  return sum;
}

function readField(block: Buffer, offset: number, length: number): string {
  let end = offset;
  const stop = offset + length;
  while (end < stop && block[end] !== 0) end += 1;
  return block.toString('utf8', offset, end);
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readField(block, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('Piper archive has a bad header.');
  return Number.parseInt(text, 8);
}

/**
 * Path segments inside `root`. Null for an absolute path, a `..` segment,
 * or an empty name. Backslashes count as separators.
 */
function safeParts(path: string): string[] | null {
  if (path.includes('\0')) return null;
  const slash = path.replace(/\\/g, '/');
  if (slash.startsWith('/') || /^[a-zA-Z]:/.test(slash)) return null;
  const parts: string[] = [];
  for (const part of slash.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts : null;
}

/** True when a symlink's target, resolved from the link, stays inside `root`. */
function linkInside(root: string, linkFile: string, target: string): boolean {
  if (target === '' || target.includes('\0')) return false;
  const slash = target.replace(/\\/g, '/');
  if (slash.startsWith('/') || /^[a-zA-Z]:/.test(slash)) return false;
  const parts = relative(root, linkFile)
    .split(/[/\\]/)
    .filter((part) => part !== '');
  parts.pop();
  for (const part of slash.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return false;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return true;
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface QueuedLink {
  path: string;
  target: string;
}

async function placeLink(
  link: QueuedLink,
  root: string,
  linkFn: (target: string, path: string) => Promise<void>,
): Promise<boolean> {
  if (!linkInside(root, link.path, link.target)) {
    throw new Error(`Piper archive link escapes the folder: ${link.target}`);
  }
  const resolved = join(dirname(link.path), link.target);
  if (!insideRoot(root, resolved)) {
    throw new Error(`Piper archive link escapes the folder: ${link.target}`);
  }
  try {
    await linkFn(link.target, link.path);
    return true;
  } catch {
    try {
      await copyFile(resolved, link.path);
      return true;
    } catch {
      // The target may itself be a link that is not a file yet.
      return false;
    }
  }
}

/** Pulls exact sizes off a gzip stream without holding the whole archive. */
class BytePipe {
  private parts: Buffer[] = [];
  private have = 0;
  private ended = false;
  private failed: Error | null = null;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  /** The next `n` bytes, or null at a clean end. A short read throws. */
  async take(n: number): Promise<Buffer | null> {
    while (this.have < n && !this.ended && !this.failed) {
      let next: IteratorResult<Buffer>;
      try {
        next = await this.source.next();
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error));
        break;
      }
      if (next.done) {
        this.ended = true;
        break;
      }
      const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (buf.length === 0) continue;
      this.parts.push(buf);
      this.have += buf.length;
    }
    if (this.have === 0) {
      if (this.failed) throw this.failed;
      return null;
    }
    if (this.have < n) throw this.failed ?? new Error('Piper archive ended early.');
    return this.cut(n);
  }

  private cut(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.parts[0];
      if (!head) break;
      const need = n - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.parts.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.parts[0] = head.subarray(need);
        filled += need;
      }
    }
    this.have -= n;
    return out;
  }
}

async function applyMode(path: string, mode: number): Promise<void> {
  if (mode === 0) return;
  try {
    await chmod(path, mode);
  } catch {
    // Windows only keeps the read-only bit. The file is still there.
  }
}

async function discard(pipe: BytePipe, bytes: number): Promise<void> {
  let left = bytes;
  while (left > 0) {
    const chunk = await pipe.take(Math.min(left, 64 * 1024));
    if (!chunk) throw new Error('Piper archive ended early.');
    left -= chunk.length;
  }
}

/**
 * Unpack a gzipped ustar archive into `dest`. Regular files keep their mode,
 * directories are created, and symlinks are linked. When `symlink` fails
 * (Windows without the privilege), the target file is copied instead, after
 * the regular files exist. An absolute path, a `..` segment, or a link that
 * points outside `dest` rejects the archive.
 */
export async function extractTarGz(
  source: Buffer | string,
  dest: string,
  options: { symlink?: (target: string, path: string) => Promise<void> } = {},
): Promise<void> {
  const linkFn = options.symlink ?? ((target, path) => fsSymlink(target, path));
  const input = typeof source === 'string' ? createReadStream(source) : Readable.from(source);
  const gunzip = createGunzip();
  const unzipped = input.pipe(gunzip);
  const pipe = new BytePipe(unzipped[Symbol.asyncIterator]());
  const links: QueuedLink[] = [];
  let entries = 0;
  try {
    await mkdir(dest, { recursive: true });
    for (;;) {
      const block = await pipe.take(BLOCK);
      if (!block) break;
      const header = parseTarHeader(block);
      if (!header) break;
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error('Piper archive has too many entries.');
      const parts = safeParts(header.path);
      if (!parts) throw new Error(`Piper archive path is not safe: ${header.path}`);
      const full = join(dest, ...parts);
      if (!insideRoot(dest, full)) {
        throw new Error(`Piper archive path is not safe: ${header.path}`);
      }
      const pad = header.size % BLOCK === 0 ? 0 : BLOCK - (header.size % BLOCK);
      if (header.type === 'dir') {
        await mkdir(full, { recursive: true });
        await applyMode(full, header.mode === 0 ? 0o755 : header.mode);
        if (header.size + pad > 0) await discard(pipe, header.size + pad);
        continue;
      }
      if (header.type === 'symlink') {
        if (header.size + pad > 0) await discard(pipe, header.size + pad);
        links.push({ path: full, target: header.linkname });
        continue;
      }
      await mkdir(dirname(full), { recursive: true });
      const handle = await open(full, 'w');
      try {
        let left = header.size;
        while (left > 0) {
          const chunk = await pipe.take(Math.min(left, 64 * 1024));
          if (!chunk) throw new Error('Piper archive ended early.');
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, offset);
            if (bytesWritten <= 0) throw new Error('Piper archive could not be written.');
            offset += bytesWritten;
          }
          left -= chunk.length;
        }
      } finally {
        await handle.close();
      }
      await applyMode(full, header.mode === 0 ? 0o644 : header.mode);
      if (pad > 0) await discard(pipe, pad);
    }
    // Links after files, so a failed symlink can copy a file that is already there.
    let pending = links;
    for (let pass = 0; pass <= links.length && pending.length > 0; pass += 1) {
      const next: QueuedLink[] = [];
      for (const link of pending) {
        const placed = await placeLink(link, dest, linkFn);
        if (!placed) next.push(link);
      }
      if (next.length === pending.length) break;
      pending = next;
    }
    if (pending.length > 0) {
      throw new Error(`Piper archive link has no target file: ${pending[0]?.target ?? ''}`);
    }
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}
