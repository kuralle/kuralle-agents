import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { BlobStore, SqlBackend } from '../src/sql/types.js';
import { SqlFileSystem } from '../src/sql/sql-fs.js';

function bunSqlBackend(db: Database): SqlBackend {
  return {
    query: (sql, ...params) => db.query(sql).all(...params) as never,
    run: (sql, ...params) => {
      db.query(sql).run(...params);
    },
  };
}

function createMemoryBlobStore(): BlobStore & { store: Map<string, Uint8Array>; puts: string[] } {
  const store = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    store,
    puts,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, data: Uint8Array) {
      puts.push(key);
      store.set(key, data);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

describe('SqlFileSystem', () => {
  it('round-trips read/write text and bytes', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });

    await fs.writeFile('/hello.txt', 'hello world');
    expect(await fs.readFile('/hello.txt')).toBe('hello world');

    const bytes = new Uint8Array([0, 1, 2, 255]);
    await fs.writeFileBytes('/data.bin', bytes);
    const read = await fs.readFileBytes('/data.bin');
    expect(read).toEqual(bytes);
  });

  it('routes large files to blob store when configured', async () => {
    const db = new Database(':memory:');
    const blobs = createMemoryBlobStore();
    const threshold = 10;
    const fs = new SqlFileSystem({
      backend: bunSqlBackend(db),
      blobs,
      inlineThreshold: threshold,
    });

    const large = new Uint8Array(threshold + 5).fill(42);
    await fs.writeFileBytes('/big.bin', large);

    expect(blobs.puts.length).toBe(1);
    const roundTrip = await fs.readFileBytes('/big.bin');
    expect(roundTrip).toEqual(large);
  });

  it('supports mkdir, readdir, and readdirWithFileTypes', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });

    await fs.mkdir('/docs');
    await fs.writeFile('/docs/a.md', 'a');
    await fs.writeFile('/docs/b.md', 'b');

    expect((await fs.readdir('/docs')).sort()).toEqual(['a.md', 'b.md']);

    const dirents = await fs.readdirWithFileTypes('/docs');
    expect(dirents.find((d) => d.name === 'a.md')?.type).toBe('file');
    expect(dirents.find((d) => d.name === 'b.md')?.type).toBe('file');
  });

  it('rm recursive cascades and non-recursive throws ENOTEMPTY', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });

    await fs.mkdir('/tree/sub', { recursive: true });
    await fs.writeFile('/tree/sub/file.txt', 'x');

    await expect(fs.rm('/tree', { recursive: false })).rejects.toThrow(
      /ENOTEMPTY/,
    );

    await fs.rm('/tree', { recursive: true });
    expect(await fs.exists('/tree')).toBe(false);
    expect(await fs.exists('/tree/sub/file.txt')).toBe(false);
  });

  it('supports cp and mv including blob-backed files', async () => {
    const db = new Database(':memory:');
    const blobs = createMemoryBlobStore();
    const fs = new SqlFileSystem({
      backend: bunSqlBackend(db),
      blobs,
      inlineThreshold: 4,
    });

    const data = new Uint8Array([9, 8, 7, 6, 5]);
    await fs.writeFileBytes('/src.bin', data);

    await fs.cp('/src.bin', '/copy.bin');
    expect(await fs.readFileBytes('/copy.bin')).toEqual(data);

    await fs.mv('/copy.bin', '/moved.bin');
    expect(await fs.exists('/copy.bin')).toBe(false);
    expect(await fs.readFileBytes('/moved.bin')).toEqual(data);
    expect(blobs.puts.length).toBe(2);
  });

  it('supports stat, lstat, and exists', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });

    await fs.mkdir('/dir');
    await fs.writeFile('/dir/file.txt', 'content');

    expect(await fs.exists('/dir')).toBe(true);
    expect(await fs.exists('/dir/file.txt')).toBe(true);
    expect(await fs.exists('/missing')).toBe(false);

    const stat = await fs.stat('/dir/file.txt');
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(7);

    await fs.symlink('/dir/file.txt', '/link');
    const lstat = await fs.lstat('/link');
    expect(lstat.type).toBe('symlink');
    const followed = await fs.stat('/link');
    expect(followed.type).toBe('file');
  });

  it('supports symlink, readlink, and realpath', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });

    await fs.writeFile('/target.txt', 't');
    await fs.symlink('/target.txt', '/link.txt');

    expect(await fs.readlink('/link.txt')).toBe('/target.txt');
    expect(await fs.realpath('/link.txt')).toBe('/target.txt');
  });

  it('glob matches patterns', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });

    await fs.mkdir('/docs/nested', { recursive: true });
    await fs.writeFile('/docs/a.md', 'a');
    await fs.writeFile('/docs/nested/b.md', 'b');
    await fs.writeFile('/docs/c.txt', 'c');

    const matches = await fs.glob('/docs/**/*.md');
    expect(matches).toContain('/docs/a.md');
    expect(matches).toContain('/docs/nested/b.md');
    expect(matches).not.toContain('/docs/c.txt');
  });

  it('throws ENOENT on missing read', async () => {
    const db = new Database(':memory:');
    const fs = new SqlFileSystem({ backend: bunSqlBackend(db) });
    await expect(fs.readFile('/missing.txt')).rejects.toThrow(/ENOENT/);
  });

  it('persists across SqlFileSystem instances on the same db', async () => {
    const db = new Database(':memory:');
    const backend = bunSqlBackend(db);

    const fs1 = new SqlFileSystem({ backend });
    await fs1.writeFile('/persist.txt', 'survives restart');
    await fs1.mkdir('/persist-dir', { recursive: true });

    const fs2 = new SqlFileSystem({ backend });
    expect(await fs2.readFile('/persist.txt')).toBe('survives restart');
    expect(await fs2.exists('/persist-dir')).toBe(true);
  });
});