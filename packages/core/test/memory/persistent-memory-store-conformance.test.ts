import { afterAll, describe, it, expect } from 'bun:test';
import os, { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { promises as fs, mkdtempSync, writeFileSync } from 'node:fs';
import {
  runPersistentMemoryDurabilityContract,
  runPersistentMemoryStoreContract,
} from '../../src/memory/blocks/testing.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import { FilePersistentMemoryStore } from '../../src/memory/blocks/FilePersistentMemoryStore.js';
import { encodeFileSegment, decodeFileSegment } from '../../src/memory/blocks/ownerKey.js';

/**
 * `InMemoryPersistentMemoryStore` and `FilePersistentMemoryStore` are the two
 * of the five `PersistentMemoryStore` backends that had no shared-contract
 * coverage — they were exactly the two backends with the owner/key collision
 * defect. `postgres-store` and `redis-store` already wire this same contract.
 */
describe('PersistentMemoryStore conformance: InMemory', () => {
  runPersistentMemoryStoreContract(() => new InMemoryPersistentMemoryStore());
  runPersistentMemoryDurabilityContract(() => {
    const store = new InMemoryPersistentMemoryStore();
    return { storeA: store, storeB: store };
  });
});

describe('PersistentMemoryStore conformance: File', () => {
  const roots: string[] = [];
  function makeStore(): FilePersistentMemoryStore {
    const rootDir = path.join(
      os.tmpdir(),
      `kuralle-wm-conformance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(rootDir);
    return new FilePersistentMemoryStore({ rootDir });
  }

  runPersistentMemoryStoreContract(() => makeStore());
  runPersistentMemoryDurabilityContract(() => {
    const rootDir = path.join(
      os.tmpdir(),
      `kuralle-wm-conformance-durability-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(rootDir);
    const storeA = new FilePersistentMemoryStore({ rootDir });
    const storeB = new FilePersistentMemoryStore({ rootDir });
    return { storeA, storeB };
  });

  afterAll(async () => {
    await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
});

/**
 * The blocker an adversarial review found: `listBlocks` decodes every filename
 * in the owner's directory, and `decodeURIComponent` throws `URIError` on a bare
 * '%'. One legacy or hand-edited file was enough to take down listing for the
 * whole (scope, owner) — and this store's own documentation invites hand-edited
 * files, since blocks are human-readable markdown an admin script may seed.
 *
 * The conformance suite could not catch it: it only ever lists names the store
 * itself just wrote, which are well-formed by construction.
 */
describe('FilePersistentMemoryStore tolerates files it did not write', () => {
  it('lists a hand-written file with a bare % instead of throwing', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'wm-stray-'));
    const store = new FilePersistentMemoryStore({ rootDir });
    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'written by the store', charLimit: 100 },
      'alice',
    );

    // An operator drops a file in by hand. '50%' is not valid percent-encoding.
    const dir = join(rootDir, 'user', 'alice');
    writeFileSync(join(dir, '50%.md'), 'seeded by an admin script');
    writeFileSync(join(dir, 'caf%C3%A9.md'), 'a properly encoded one');

    const listed = await store.listBlocks('user', 'alice');
    expect(listed).toContain('USER');
    expect(listed).toContain('50%'); // returned verbatim, not dropped, not thrown
    expect(listed).toContain('café'); // valid encoding still decodes
  });
});

/**
 * Two more the re-review found, both about filesystems rather than key algebra.
 */
describe('FilePersistentMemoryStore respects filesystem reserved names', () => {
  it('escapes Windows device names so NUL.md is a file, not the null device', () => {
    // Every one of these is a legal allow-list identifier, and 'MEMORY'-style
    // block keys make an all-caps name likely rather than exotic.
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'nul', 'Com3']) {
      const encoded = encodeFileSegment(name);
      expect(encoded).not.toBe(name);
      expect(decodeFileSegment(encoded)).toBe(name); // still reversible
    }
    // and an ordinary name that merely starts the same way is untouched
    expect(encodeFileSegment('CONTACT')).toBe('CONTACT');
    expect(encodeFileSegment('NULLABLE')).toBe('NULLABLE');
    expect(encodeFileSegment('COM10')).toBe('COM10');
  });

  it('does not list a key twice when a legacy file decodes onto a real one', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'wm-dupe-'));
    const store = new FilePersistentMemoryStore({ rootDir });
    // The store's own write for the key '50%' lands in '50%25.md'.
    await store.saveBlock(
      { key: '50%', scope: 'user', content: 'written by the store', charLimit: 100 },
      'alice',
    );
    // A legacy file decodes to the same string.
    writeFileSync(join(rootDir, 'user', 'alice', '50%.md'), 'hand written');

    const listed = await store.listBlocks('user', 'alice');
    expect(listed.filter((k) => k === '50%')).toHaveLength(1);
    // and the key that IS loadable is the store's own
    expect((await store.loadBlock('user', 'alice', '50%'))?.content).toBe('written by the store');
  });
});
