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

  it('read truncates files beyond 2000 lines', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line-${i + 1}`);
    const fs = new InMemoryFs({ '/big.txt': lines.join('\n') });
    const result = await run(fs, { op: 'read', path: '/big.txt' });
    expect(result).toMatchObject({
      op: 'read',
      ok: true,
      truncated: true,
      note: expect.stringContaining('2000 lines'),
    });
    const content = (result as { content: string }).content;
    expect(content.split('\n').length).toBe(2000);
    expect(content.startsWith('line-1\n')).toBe(true);
    expect(content.endsWith('line-2000')).toBe(true);
  });

  it('read with offset and limit returns the requested window', async () => {
    const fs = new InMemoryFs({
      '/window.txt': 'one\ntwo\nthree\nfour\nfive',
    });
    const result = await run(fs, {
      op: 'read',
      path: '/window.txt',
      offset: 2,
      limit: 2,
    });
    expect(result).toMatchObject({
      op: 'read',
      ok: true,
      path: '/window.txt',
      content: 'two\nthree',
      truncated: true,
    });
  });

  it('grep caps results beyond 200 hits', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) {
      files[`/hits/f-${i}.txt`] = 'needle here';
    }
    const fs = new InMemoryFs(files);
    const result = await run(fs, { op: 'grep', pattern: 'needle', path: '/' });
    const hits = (result as { hits: unknown[] }).hits;
    expect(hits).toHaveLength(200);
    expect(result).toMatchObject({ truncated: true });
  });

  it('grep truncates hit lines beyond 500 characters', async () => {
    const longLine = `match-${'x'.repeat(600)}`;
    const fs = new InMemoryFs({ '/long.txt': longLine });
    const result = await run(fs, { op: 'grep', pattern: 'match', path: '/' });
    const hit = (result as { hits: { text: string }[] }).hits[0]!;
    expect(hit.text.length).toBe(501);
    expect(hit.text.endsWith('…')).toBe(true);
  });

  it('grep accepts g and m flags without throwing', async () => {
    const fs = new InMemoryFs({ '/flags.txt': 'Foo\nbar\nFOO' });
    const result = await run(fs, {
      op: 'grep',
      pattern: '^foo$',
      path: '/',
      flags: 'gim',
    });
    expect(result).toMatchObject({ op: 'grep', ok: true });
    const hits = (result as { hits: { text: string }[] }).hits;
    expect(hits.map((h) => h.text)).toEqual(['Foo', 'FOO']);
  });

  it('edit throws when find string is missing', async () => {
    const fs = new InMemoryFs({ '/edit.txt': 'only one line' });
    await expect(
      run(fs, {
        op: 'edit',
        path: '/edit.txt',
        find: 'missing',
        replace: 'x',
      }),
    ).rejects.toThrow(/ENOENT: find string not found/);
  });

  it('edit throws when find string matches more than once', async () => {
    const fs = new InMemoryFs({ '/edit.txt': 'dup dup tail' });
    await expect(
      run(fs, {
        op: 'edit',
        path: '/edit.txt',
        find: 'dup',
        replace: 'once',
      }),
    ).rejects.toThrow(/EAMBIG: 2 occurrences/);
  });

  it('edit with replaceAll replaces every occurrence', async () => {
    const fs = new InMemoryFs({ '/edit.txt': 'dup dup tail' });
    const result = await run(fs, {
      op: 'edit',
      path: '/edit.txt',
      find: 'dup',
      replace: 'once',
      replaceAll: true,
    });
    expect(result).toMatchObject({
      op: 'edit',
      ok: true,
      path: '/edit.txt',
      replacements: 2,
    });
    expect(await fs.readFile('/edit.txt')).toBe('once once tail');
  });
});
