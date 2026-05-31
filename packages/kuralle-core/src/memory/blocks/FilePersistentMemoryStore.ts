/**
 * File-backed default implementation of PersistentMemoryStore.
 *
 * Layout:
 *   <root>/
 *     user/<owner>/<key>.md       (scope=user)
 *     shared/<owner>/<key>.md     (scope=shared)
 *     agent/<owner>/<key>.md      (scope=agent)
 *
 * Defaults to `process.env.KURALLE_MEMORY_DIR ?? <homedir>/.kuralle/memories`.
 *
 * Atomicity: writes go to a sibling `.tmp` file then `rename` over the
 * target. `rename` is atomic on POSIX within a single filesystem;
 * Windows is best-effort.
 *
 * Char limit + safety scanning live in the runtime layer (memoryBlockTool),
 * NOT here — this store deliberately accepts whatever it's given so apps
 * that bypass the tool (e.g. an admin script seeding USER.md) can still
 * write.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type PersistentMemoryStore,
  type PersistentMemoryBlock,
  type MemoryBlockScope,
} from './types.js';

export interface FilePersistentMemoryStoreOptions {
  /** Root directory. Defaults to `KURALLE_MEMORY_DIR` or `~/.kuralle/memories`. */
  rootDir?: string;
}

export class FilePersistentMemoryStore implements PersistentMemoryStore {
  readonly rootDir: string;

  constructor(opts: FilePersistentMemoryStoreOptions = {}) {
    this.rootDir =
      opts.rootDir ??
      process.env.KURALLE_MEMORY_DIR ??
      path.join(os.homedir(), '.kuralle', 'memories');
  }

  private safe(part: string): string {
    // Path-traversal guard: strip any '..', '/', '\\', and null bytes
    // from owner/key inputs. Owner ids may be email-like (contains @),
    // key may be PascalCase — both fine.
    return part.replace(/[\\/]+|\.\.+|\0/g, '_');
  }

  private pathFor(scope: MemoryBlockScope, owner: string, key: string): string {
    return path.join(this.rootDir, this.safe(scope), this.safe(owner), `${this.safe(key)}.md`);
  }

  private dirFor(scope: MemoryBlockScope, owner: string): string {
    return path.join(this.rootDir, this.safe(scope), this.safe(owner));
  }

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    const file = this.pathFor(scope, owner, key);
    try {
      const content = await fs.readFile(file, 'utf8');
      const stat = await fs.stat(file);
      return {
        key,
        scope,
        content,
        // charLimit is informational at load-time — actual enforcement is
        // on the write path. Set to current length so callers can read
        // "what limit was the data written under" without storing it
        // separately.
        charLimit: content.length,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    const file = this.pathFor(block.scope, owner, block.key);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });

    // Atomic write via .tmp + rename. The tmp filename is unique per
    // write to avoid races between concurrent writers to the same key.
    const tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tmp, block.content, 'utf8');
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      // Cleanup tmp if rename failed for any reason
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    const file = this.pathFor(scope, owner, key);
    try {
      await fs.unlink(file);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    const dir = this.dirFor(scope, owner);
    try {
      const entries = await fs.readdir(dir);
      return entries
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.slice(0, -3))
        .sort();
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
