import { describe, expect, it } from 'bun:test';
import type { FileSystem } from '@kuralle-agents/core';
import { CompositeFileSystem, InMemoryFs } from '../src/index.js';

function readOnlyMount(fs: InMemoryFs): FileSystem & { readOnly: true } {
  return Object.assign(fs, { readOnly: true as const });
}

describe('test:composite-fs', () => {
  it('routes by longest path prefix', async () => {
    const data = new InMemoryFs({ '/guide.md': 'data content' });
    const datastore = new InMemoryFs({ '/guide.md': 'datastore content' });
    const fs = new CompositeFileSystem({
      mounts: {
        '/data': data,
        '/datastore': datastore,
      },
    });

    expect(await fs.readFile('/data/guide.md')).toBe('data content');
    expect(await fs.readFile('/datastore/guide.md')).toBe('datastore content');
  });

  it('readdir on / lists mount roots', async () => {
    const fs = new CompositeFileSystem({
      mounts: {
        '/docs': new InMemoryFs(),
        '/scratch': new InMemoryFs(),
      },
    });
    expect(await fs.readdir('/')).toEqual(['docs', 'scratch']);
  });

  it('read and write route to the correct mount', async () => {
    const docs = readOnlyMount(new InMemoryFs({ '/readme.md': 'bundled' }));
    const scratch = new InMemoryFs();
    const fs = new CompositeFileSystem({
      mounts: { '/docs': docs, '/scratch': scratch },
    });

    expect(await fs.readFile('/docs/readme.md')).toBe('bundled');
    await fs.writeFile('/scratch/note.md', 'draft');
    expect(await scratch.readFile('/note.md')).toBe('draft');
    expect(await fs.readFile('/scratch/note.md')).toBe('draft');
  });

  it('readOnly is true only when every mount is read-only', () => {
    const allRo = new CompositeFileSystem({
      mounts: {
        '/docs': readOnlyMount(new InMemoryFs()),
        '/kb': readOnlyMount(new InMemoryFs()),
      },
    });
    expect(allRo.readOnly).toBe(true);

    const mixed = new CompositeFileSystem({
      mounts: {
        '/docs': readOnlyMount(new InMemoryFs()),
        '/scratch': new InMemoryFs(),
      },
    });
    expect(mixed.readOnly).toBeUndefined();
  });

  it('blocks writes to read-only mounts', async () => {
    const fs = new CompositeFileSystem({
      mounts: { '/docs': readOnlyMount(new InMemoryFs()) },
    });
    await expect(fs.writeFile('/docs/x.md', 'nope')).rejects.toThrow(/EROFS/);
  });

  it('copies across mounts', async () => {
    const docs = readOnlyMount(
      new InMemoryFs({ '/policy.md': 'return within 30 days' }),
    );
    const scratch = new InMemoryFs();
    const fs = new CompositeFileSystem({
      mounts: { '/docs': docs, '/scratch': scratch },
    });

    await fs.cp('/docs/policy.md', '/scratch/policy-copy.md');
    expect(await fs.readFile('/scratch/policy-copy.md')).toBe('return within 30 days');
  });

  it('throws ENOENT for unmounted paths', async () => {
    const fs = new CompositeFileSystem({
      mounts: { '/docs': new InMemoryFs() },
    });
    await expect(fs.readFile('/missing/file.md')).rejects.toThrow(/ENOENT/);
    await expect(fs.readdir('/nowhere')).rejects.toThrow(/ENOENT/);
  });

  it('rejects nested mount paths', () => {
    expect(
      () =>
        new CompositeFileSystem({
          mounts: {
            '/data': new InMemoryFs(),
            '/data/sub': new InMemoryFs(),
          },
        }),
    ).toThrow(/Nested mount paths/);
  });
});
