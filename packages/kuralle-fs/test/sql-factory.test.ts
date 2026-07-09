import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { SqlBackend, BlobStore } from '../src/index.js';
import { sqlFileSystem, r2BlobStore } from '../src/index.js';

// A raw SqlBackend over bun:sqlite, reused as the body of the fake CF sources.
function bunBackend(db = new Database(':memory:')): SqlBackend {
  return {
    query: (sql, ...p) => db.query(sql).all(...p) as never,
    run: (sql, ...p) => {
      db.query(sql).run(...p);
    },
  };
}

describe('sqlFileSystem factory', () => {
  it('accepts a raw SqlBackend', async () => {
    const fs = sqlFileSystem(bunBackend());
    await fs.writeFile('/a.txt', 'raw');
    expect(await fs.readFile('/a.txt')).toBe('raw');
  });

  it('auto-detects a Cloudflare SqlStorage shape (exec + databaseSize)', async () => {
    const db = new Database(':memory:');
    const fakeSqlStorage = {
      databaseSize: 0,
      exec: (sql: string, ...params: unknown[]) => db.query(sql).all(...(params as never[])) as never,
    };
    const fs = sqlFileSystem(fakeSqlStorage);
    await fs.writeFile('/b.txt', 'do');
    expect(await fs.readFile('/b.txt')).toBe('do');
  });

  it('auto-detects a D1Database shape (prepare + batch)', async () => {
    const db = new Database(':memory:');
    const fakeD1 = {
      batch: async () => [],
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          all: async () => ({ results: db.query(sql).all(...(values as never[])) as never }),
          run: async () => db.query(sql).run(...(values as never[])),
        }),
      }),
    };
    const fs = sqlFileSystem(fakeD1);
    await fs.writeFile('/c.txt', 'd1');
    expect(await fs.readFile('/c.txt')).toBe('d1');
  });
});

describe('r2BlobStore', () => {
  it('get/put/delete over a Map-backed bucket, with prefix', async () => {
    const store = new Map<string, Uint8Array>();
    const bucket = {
      get: async (key: string) => {
        const v = store.get(key);
        return v ? { arrayBuffer: async () => v.buffer as ArrayBuffer } : null;
      },
      put: async (key: string, data: ArrayBuffer | Uint8Array) => {
        store.set(key, data instanceof Uint8Array ? data : new Uint8Array(data));
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    };
    const blobs: BlobStore = r2BlobStore(bucket, { prefix: 'ws/' });
    await blobs.put('k', new Uint8Array([1, 2, 3]));
    expect(store.has('ws/k')).toBe(true);
    expect([...(await blobs.get('k'))!]).toEqual([1, 2, 3]);
    expect(await blobs.get('missing')).toBe(null);
    await blobs.delete('k');
    expect(store.has('ws/k')).toBe(false);
  });
});
