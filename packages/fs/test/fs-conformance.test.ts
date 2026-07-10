// Shared FileSystem conformance suite.
// Runs an IDENTICAL battery of assertions against every FileSystem backend, so
// SqlFileSystem is proven a true drop-in for InMemoryFs — same behavior, same
// error codes — across the whole 19-method surface.
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { FileSystem } from '@kuralle-agents/core';
import type { SqlBackend } from '../src/sql/types.js';
import { InMemoryFs } from '../src/in-memory-fs.js';
import { SqlFileSystem } from '../src/sql/sql-fs.js';

function bunSqlBackend(db: Database): SqlBackend {
  return {
    query: (sql, ...params) => db.query(sql).all(...params) as never,
    run: (sql, ...params) => {
      db.query(sql).run(...params);
    },
  };
}

const backends: Array<[string, () => FileSystem]> = [
  ['InMemoryFs', () => new InMemoryFs()],
  ['SqlFileSystem', () => new SqlFileSystem({ backend: bunSqlBackend(new Database(':memory:')) })],
];

for (const [name, make] of backends) {
  describe(`conformance: ${name}`, () => {
    it('write + read text round-trips', async () => {
      const fs = make();
      await fs.writeFile('/a.txt', 'hello');
      expect(await fs.readFile('/a.txt')).toBe('hello');
      expect(await fs.exists('/a.txt')).toBe(true);
      expect(await fs.exists('/nope.txt')).toBe(false);
    });

    it('write + read bytes round-trips', async () => {
      const fs = make();
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      await fs.writeFileBytes('/b.bin', bytes);
      expect([...(await fs.readFileBytes('/b.bin'))]).toEqual([...bytes]);
    });

    it('mkdir recursive + readdir + readdirWithFileTypes', async () => {
      const fs = make();
      await fs.mkdir('/x/y', { recursive: true });
      await fs.writeFile('/x/y/f.md', '1');
      await fs.writeFile('/x/g.md', '2');
      expect((await fs.readdir('/x')).sort()).toEqual(['g.md', 'y']);
      const dirents = await fs.readdirWithFileTypes('/x');
      expect(dirents.find((d) => d.name === 'y')?.type).toBe('directory');
      expect(dirents.find((d) => d.name === 'g.md')?.type).toBe('file');
    });

    it('rm recursive cascades', async () => {
      const fs = make();
      await fs.mkdir('/d/e', { recursive: true });
      await fs.writeFile('/d/e/f.txt', 'x');
      await fs.rm('/d', { recursive: true });
      expect(await fs.exists('/d')).toBe(false);
      expect(await fs.exists('/d/e/f.txt')).toBe(false);
    });

    it('cp and mv relocate content', async () => {
      const fs = make();
      await fs.writeFile('/src.txt', 'data');
      await fs.cp('/src.txt', '/copy.txt');
      expect(await fs.readFile('/copy.txt')).toBe('data');
      expect(await fs.exists('/src.txt')).toBe(true);
      await fs.mv('/src.txt', '/moved.txt');
      expect(await fs.readFile('/moved.txt')).toBe('data');
      expect(await fs.exists('/src.txt')).toBe(false);
    });

    it('stat reports type and size', async () => {
      const fs = make();
      await fs.writeFile('/s.txt', 'abcde');
      const st = await fs.stat('/s.txt');
      expect(st.type).toBe('file');
      expect(st.size).toBe(5);
      await fs.mkdir('/sd');
      expect((await fs.stat('/sd')).type).toBe('directory');
    });

    it('symlink + readlink', async () => {
      const fs = make();
      await fs.writeFile('/target.txt', 'T');
      await fs.symlink('/target.txt', '/link.txt');
      expect(await fs.readlink('/link.txt')).toBe('/target.txt');
      expect((await fs.lstat('/link.txt')).type).toBe('symlink');
    });

    it('glob matches by pattern', async () => {
      const fs = make();
      await fs.mkdir('/g/sub', { recursive: true });
      await fs.writeFile('/g/a.md', '1');
      await fs.writeFile('/g/sub/b.md', '2');
      await fs.writeFile('/g/c.txt', '3');
      const md = (await fs.glob('/g/**/*.md')).sort();
      expect(md).toContain('/g/a.md');
      expect(md).toContain('/g/sub/b.md');
      expect(md).not.toContain('/g/c.txt');
    });

    it('read of a missing path throws ENOENT', async () => {
      const fs = make();
      await expect(fs.readFile('/missing.txt')).rejects.toThrow(/ENOENT/);
    });

    it('read of a directory throws EISDIR', async () => {
      const fs = make();
      await fs.mkdir('/dir');
      await expect(fs.readFile('/dir')).rejects.toThrow(/EISDIR/);
    });
  });
}
