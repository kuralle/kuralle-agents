import { describe, expect, it } from 'bun:test';
import { InMemoryFs } from '../src/in-memory-fs.js';

describe('test:inmemoryfs', () => {
  it('round-trips read/write/readdir/stat/rm', async () => {
    const fs = new InMemoryFs({
      '/docs/hello.md': '# Hello',
      '/docs/nested/deep.txt': 'deep',
    });

    expect(await fs.exists('/docs')).toBe(true);
    expect(await fs.readFile('/docs/hello.md')).toBe('# Hello');

    const stat = await fs.stat('/docs/hello.md');
    expect(stat.type).toBe('file');
    expect(stat.size).toBeGreaterThan(0);

    const entries = await fs.readdir('/docs');
    expect(entries.sort()).toEqual(['hello.md', 'nested']);

    await fs.writeFile('/docs/new.md', 'new');
    expect(await fs.readFile('/docs/new.md')).toBe('new');

    await fs.appendFile('/docs/new.md', '!');
    expect(await fs.readFile('/docs/new.md')).toBe('new!');

    await fs.mkdir('/docs/sub', { recursive: true });
    expect(await fs.exists('/docs/sub')).toBe(true);

    await fs.cp('/docs/hello.md', '/docs/copy.md');
    expect(await fs.readFile('/docs/copy.md')).toBe('# Hello');

    await fs.mv('/docs/copy.md', '/docs/moved.md');
    expect(await fs.exists('/docs/copy.md')).toBe(false);
    expect(await fs.readFile('/docs/moved.md')).toBe('# Hello');

    await fs.rm('/docs/moved.md');
    expect(await fs.exists('/docs/moved.md')).toBe(false);

    const dirents = await fs.readdirWithFileTypes('/docs');
    expect(dirents.some((d) => d.name === 'hello.md' && d.type === 'file')).toBe(true);

    await fs.symlink('/docs/hello.md', '/docs/link.md');
    expect(await fs.readlink('/docs/link.md')).toBe('/docs/hello.md');
    expect(await fs.realpath('/docs/link.md')).toBe('/docs/hello.md');

    const globbed = await fs.glob('/docs/**/*.md');
    expect(globbed).toContain('/docs/hello.md');
  });

  it('throws ENOENT for missing paths', async () => {
    const fs = new InMemoryFs();
    await expect(fs.readFile('/missing.txt')).rejects.toThrow(/ENOENT/);
    await expect(fs.stat('/missing.txt')).rejects.toThrow(/ENOENT/);
  });

  it('throws EISDIR when reading a directory', async () => {
    const fs = new InMemoryFs({ '/dir/file.txt': 'x' });
    await fs.mkdir('/empty');
    await expect(fs.readFile('/empty')).rejects.toThrow(/EISDIR/);
  });

  it('throws ENOTDIR when listing a file', async () => {
    const fs = new InMemoryFs({ '/file.txt': 'x' });
    await expect(fs.readdir('/file.txt')).rejects.toThrow(/ENOTDIR/);
  });
});
