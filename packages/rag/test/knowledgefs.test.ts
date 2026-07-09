import { describe, expect, it } from 'bun:test';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import { KB_INDEX, seedKnowledgeStore } from './knowledgefs-fixture.js';

describe('test:kfs-cat', () => {
  it('reassembles chunks in chunk_index order and caches on reread', async () => {
    const store = await seedKnowledgeStore([
      {
        path: '/docs/guide.md',
        chunks: ['# Guide\n\n', 'Step one: install.\n', 'Step two: configure.\n'],
      },
    ]);

    const fs = await KnowledgeFs.open({ store, indexName: KB_INDEX });
    const first = await fs.readFile('/docs/guide.md');
    expect(first).toBe('# Guide\n\nStep one: install.\nStep two: configure.\n');

    const second = await fs.readFile('/docs/guide.md');
    expect(second).toBe(first);
  });
});

describe('test:kfs-erofs', () => {
  it('write and mutate ops throw EROFS', async () => {
    const store = await seedKnowledgeStore([
      { path: '/docs/a.md', chunks: ['hello'] },
    ]);
    const fs = await KnowledgeFs.open({ store, indexName: KB_INDEX });

    await expect(fs.writeFile('/docs/new.md', 'nope')).rejects.toThrow(/EROFS/);
    await expect(fs.writeFileBytes('/docs/new.md', new Uint8Array([1]))).rejects.toThrow(
      /EROFS/,
    );
    await expect(fs.appendFile('/docs/a.md', 'x')).rejects.toThrow(/EROFS/);
    await expect(fs.mkdir('/docs/sub')).rejects.toThrow(/EROFS/);
    await expect(fs.rm('/docs/a.md')).rejects.toThrow(/EROFS/);
    await expect(fs.cp('/docs/a.md', '/docs/b.md')).rejects.toThrow(/EROFS/);
    await expect(fs.mv('/docs/a.md', '/docs/b.md')).rejects.toThrow(/EROFS/);
    await expect(fs.symlink('/x', '/docs/link.md')).rejects.toThrow(/EROFS/);
  });
});

describe('test:kfs-tree', () => {
  it('ls/stat/exists resolve from memory without extra store reads', async () => {
    const store = await seedKnowledgeStore([
      { path: '/kb/a.md', chunks: ['a'] },
      { path: '/kb/sub/b.md', chunks: ['b'] },
    ]);
    const fs = await KnowledgeFs.open({ store, indexName: KB_INDEX });

    const originalList = store.listEntries.bind(store);
    let listCalls = 0;
    store.listEntries = async (...args) => {
      listCalls++;
      return originalList(...args);
    };

    expect(await fs.exists('/kb')).toBe(true);
    expect(await fs.exists('/kb/a.md')).toBe(true);
    const entries = await fs.readdirWithFileTypes('/kb');
    expect(entries.map((e) => e.name).sort()).toEqual(['a.md', 'sub']);
    const stat = await fs.stat('/kb/a.md');
    expect(stat.type).toBe('file');
    expect(listCalls).toBe(0);
  });
});

describe('test:kfs-manifest', () => {
  it('builds tree from manifest when present', async () => {
    const store = await seedKnowledgeStore(
      [{ path: '/manifest-only.md', chunks: ['body'] }],
      { manifest: true },
    );
    const fs = await KnowledgeFs.open({ store, indexName: KB_INDEX });
    expect(await fs.exists('/manifest-only.md')).toBe(true);
    expect(await fs.readFile('/manifest-only.md')).toBe('body');
  });
});
