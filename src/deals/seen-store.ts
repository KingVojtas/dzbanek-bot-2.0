import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface ScopeBucket {
  ids: string[];
  updatedAt: string;
}

type StoreFile = Record<string, ScopeBucket>;

/**
 * Persistent JSON set of already-posted IDs, scoped (e.g. "steam:deals", "epic:lineup").
 * Survives restarts so the bot never re-spams the same deal or free-game lineup.
 */
export class SeenStore {
  private data: StoreFile = {};
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxIds: number,
  ) {}

  async has(scope: string, id: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.data[scope]?.ids.includes(id) ?? false;
  }

  async isEmpty(scope: string): Promise<boolean> {
    await this.ensureLoaded();
    return !this.data[scope] || this.data[scope].ids.length === 0;
  }

  async add(scope: string, ids: string[]): Promise<void> {
    await this.ensureLoaded();
    if (ids.length === 0) return;

    const bucket = this.data[scope] ?? { ids: [], updatedAt: new Date().toISOString() };
    const seen = new Set(bucket.ids);
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      bucket.ids.push(id);
    }
    if (bucket.ids.length > this.maxIds) {
      bucket.ids = bucket.ids.slice(bucket.ids.length - this.maxIds);
    }
    bucket.updatedAt = new Date().toISOString();
    this.data[scope] = bucket;
    await this.save();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      this.data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    });
    await this.writeQueue;
  }
}
