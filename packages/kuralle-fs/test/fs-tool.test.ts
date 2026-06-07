import { describe, expect, it } from 'bun:test';
import { createFsTool, InMemoryFs } from '../src/index.js';

describe('test:fs-tool', () => {
  const seed = {
    '/docs/a.md': 'alpha line\nbeta line',
    '/docs/b.md': 'gamma',
    '/notes/c.txt': 'alpha note',
  };

  async function run(
    fs: InMemoryFs,
    args: Parameters<NonNullable<ReturnType<typeof createFsTool>['execute']>>[0],
    readOnly = false,
  ) {
    const tool = createFsTool({ fs, readOnly });
    if (!tool.execute) throw new Error('missing execute');
    return tool.execute(args);
  }

  it('ls returns structured entries', async () => {
    const fs = new InMemoryFs(seed);
    const result = await run(fs, { op: 'ls', path: '/docs' });
    expect(result).toMatchObject({ op: 'ls', ok: true, path: '/docs' });
    expect(Array.isArray((result as { entries: unknown[] }).entries)).toBe(true);
  });

  it('cat/read return structured content', async () => {
    const fs = new InMemoryFs(seed);
    const cat = await run(fs, { op: 'cat', path: '/docs/a.md' });
    expect(cat).toEqual({
      op: 'cat',
      ok: true,
      path: '/docs/a.md',
      content: 'alpha line\nbeta line',
    });

    const read = await run(fs, { op: 'read', path: '/docs/a.md' });
    expect(read).toMatchObject({ op: 'read', ok: true, content: 'alpha line\nbeta line' });
  });

  it('grep returns structured hits', async () => {
    const fs = new InMemoryFs(seed);
    const result = await run(fs, { op: 'grep', pattern: 'alpha', path: '/' });
    expect(result).toMatchObject({ op: 'grep', ok: true, pattern: 'alpha' });
    const hits = (result as { hits: { path: string }[] }).hits;
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('find returns structured paths', async () => {
    const fs = new InMemoryFs(seed);
    const result = await run(fs, { op: 'find', root: '/docs', glob: '/docs/*.md' });
    expect(result).toMatchObject({ op: 'find', ok: true, root: '/docs' });
    const paths = (result as { paths: string[] }).paths;
    expect(paths).toContain('/docs/a.md');
    expect(paths).toContain('/docs/b.md');
  });

  it('write/edit return ok and mutate the fs', async () => {
    const fs = new InMemoryFs(seed);
    await run(fs, { op: 'write', path: '/docs/new.md', content: 'fresh' });
    expect(await fs.readFile('/docs/new.md')).toBe('fresh');

    await run(fs, {
      op: 'edit',
      path: '/docs/new.md',
      find: 'fresh',
      replace: 'updated',
    });
    expect(await fs.readFile('/docs/new.md')).toBe('updated');
  });

  it('readOnly write throws EROFS', async () => {
    const fs = new InMemoryFs(seed);
    await expect(
      run(fs, { op: 'write', path: '/docs/x.md', content: 'nope' }, true),
    ).rejects.toThrow(/EROFS/);
  });

  it('missing path surfaces ENOENT', async () => {
    const fs = new InMemoryFs();
    await expect(run(fs, { op: 'cat', path: '/missing.md' })).rejects.toThrow(/ENOENT/);
  });
});
