// Platform factory: wire a SqlFileSystem to the SQL handle a dev already has —
// a Cloudflare DO `ctx.storage.sql` (SqlStorage), a `D1Database`, or a raw
// SqlBackend. Auto-detect modeled on the CF Agents SDK `@cloudflare/shell`
// `toBackend` (filesystem.ts). Zero `node:*` — Workers-clean.
import type { BlobStore, SqlBackend, SqlParam } from './types.js';
import { SqlFileSystem } from './sql-fs.js';

/** Minimal structural shape of a Cloudflare DO SqlStorage (no @cloudflare/workers-types dep). */
export interface SqlStorageLike {
  // Read rows may include ArrayBuffer (BLOB columns) — matches CF `SqlStorageValue`;
  // `SqlParam` stays the (narrower) bind-parameter type.
  exec(query: string, ...bindings: SqlParam[]): Iterable<Record<string, SqlParam | ArrayBuffer>>;
  databaseSize: number;
}

/** Minimal structural shape of a D1Database. */
export interface D1DatabaseLike {
  prepare(query: string): {
    bind(...values: SqlParam[]): {
      all(): Promise<{ results: Record<string, SqlParam>[] }>;
      run(): Promise<unknown>;
    };
  };
  batch(statements: unknown[]): Promise<unknown>;
}

export type SqlSource = SqlStorageLike | D1DatabaseLike | SqlBackend;

export interface SqlFileSystemFactoryOptions {
  namespace?: string;
  blobs?: BlobStore;
  inlineThreshold?: number;
}

function isSqlStorage(src: SqlSource): src is SqlStorageLike {
  return typeof src === 'object' && src !== null && 'databaseSize' in src;
}

function isD1(src: SqlSource): src is D1DatabaseLike {
  return (
    typeof src === 'object' &&
    src !== null &&
    'prepare' in src &&
    'batch' in src
  );
}

/** Adapt any supported SQL source to the two-method SqlBackend. */
export function toSqlBackend(src: SqlSource): SqlBackend {
  if (isSqlStorage(src)) {
    return {
      query: (sql, ...params) => [...src.exec(sql, ...params)] as never,
      run: (sql, ...params) => {
        src.exec(sql, ...params);
      },
    };
  }
  if (isD1(src)) {
    return {
      query: async (sql, ...params) => {
        const r = await src.prepare(sql).bind(...params).all();
        return r.results as never;
      },
      run: async (sql, ...params) => {
        await src.prepare(sql).bind(...params).run();
      },
    };
  }
  return src;
}

/**
 * Persistent workspace filesystem over any SQL source. On Cloudflare pass a
 * Durable Object's `ctx.storage.sql` or `env.DB` (D1); optionally `blobs` for
 * large-file spillover to R2. Lazy-inits on first use.
 */
export function sqlFileSystem(
  source: SqlSource,
  options?: SqlFileSystemFactoryOptions,
): SqlFileSystem {
  return new SqlFileSystem({ backend: toSqlBackend(source), ...options });
}
