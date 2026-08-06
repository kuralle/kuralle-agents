/**
 * File-backed `ExtractedValueStore` for Node.
 *
 *   <root>/<scope>/<owner>/<slug>.json
 *
 * Key encoding is INJECTIVE, unlike `FilePersistentMemoryStore.safe()`, which
 * collapses `/`, `\` and `..` to a single `_` and therefore maps `alice/bob`,
 * `alice\bob` and `alice_bob` onto one file. That is a path-traversal guard
 * being used as a key derivation, and it is a live collision in the block
 * stores. A new store should not inherit it: every byte outside
 * `[A-Za-z0-9._-]` is percent-encoded, which is reversible, filesystem-safe on
 * POSIX and Windows, and cannot collide.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryBlockScope } from '../blocks/types.js';
import type { ExtractedValue, ExtractedValueStore } from './store.js';
import { registerNodeDefaultExtractedValueStore } from './resolveExtractedValueStore.js';

export interface FileExtractedValueStoreOptions {
  /** Root directory. Defaults to `KURALLE_MEMORY_DIR`/extracted or `~/.kuralle/extracted`. */
  rootDir?: string;
}

/** Percent-encode anything outside a conservative filesystem-safe set. Injective. */
function encodeSegment(part: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(part)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9._-]/.test(ch) && !(ch === '.' && part === '..')) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  // '.' and '..' are directory entries, not names. Encoding the dots keeps them
  // addressable without ever producing a traversal segment.
  return out === '.' || out === '..' ? out.replace(/\./g, '%2E') : out;
}

export class FileExtractedValueStore implements ExtractedValueStore {
  readonly rootDir: string;

  constructor(opts: FileExtractedValueStoreOptions = {}) {
    this.rootDir =
      opts.rootDir ??
      (process.env.KURALLE_MEMORY_DIR
        ? path.join(process.env.KURALLE_MEMORY_DIR, 'extracted')
        : path.join(os.homedir(), '.kuralle', 'extracted'));
  }

  private pathFor(scope: MemoryBlockScope, owner: string, slug: string): string {
    return path.join(
      this.rootDir,
      encodeSegment(scope),
      encodeSegment(owner),
      `${encodeSegment(slug)}.json`,
    );
  }

  async load(
    scope: MemoryBlockScope,
    owner: string,
    slug: string,
  ): Promise<ExtractedValue | null> {
    try {
      const raw = await fs.readFile(this.pathFor(scope, owner, slug), 'utf8');
      return JSON.parse(raw) as ExtractedValue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // A corrupt row is not a missing row: surfacing it beats silently
      // re-extracting over the top of something that may still be recoverable.
      throw error;
    }
  }

  async save(value: ExtractedValue, owner: string): Promise<void> {
    const file = this.pathFor(value.scope, owner, value.slug);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous value intact
    // rather than a truncated JSON row that `load` would then throw on.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(scope, owner, slug));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// Importing this module on Node makes it the default extracted-value store,
// so a deployment that configures nothing still gets durable facts.
registerNodeDefaultExtractedValueStore(() => new FileExtractedValueStore());
