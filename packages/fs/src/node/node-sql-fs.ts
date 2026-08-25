// `nodeSqlFileSystem` — a persistent SqlFileSystem on the Node/Bun platform,
// backed by the built-in sync SQLite driver (`node:sqlite` on Node >= 22.5,
// `bun:sqlite` on Bun). Lives behind the `@kuralle-agents/fs/node` subpath.
import { createRequire } from 'node:module';
import type { SqlBackend, SqlParam } from '../sql/types.js';
import { SqlFileSystem } from '../sql/sql-fs.js';
import type { SqlFileSystemFactoryOptions } from '../sql/factory.js';

const require = createRequire(import.meta.url);

interface SyncSqlStatement {
  all(...params: (string | number | null)[]): unknown[];
  run(...params: (string | number | null)[]): void;
}

interface BunSyncDatabase {
  query(sql: string): SyncSqlStatement;
}

interface NodeSyncDatabase {
  prepare(sql: string): SyncSqlStatement;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

// node:sqlite's SQLInputValue excludes `boolean`; coerce to 0/1 (SqlFileSystem
// never binds booleans, but the SqlBackend contract permits them).
function coerce(params: SqlParam[]): (string | number | null)[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function openSyncDatabase(dbPath: string): BunSyncDatabase | NodeSyncDatabase {
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as { Database: new (path: string) => BunSyncDatabase };
    return new Database(dbPath);
  }
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => NodeSyncDatabase;
  };
  return new DatabaseSync(dbPath);
}

function syncSqlBackend(db: BunSyncDatabase | NodeSyncDatabase): SqlBackend {
  if (isBunRuntime()) {
    const bunDb = db as BunSyncDatabase;
    return {
      query: (sql, ...params) => bunDb.query(sql).all(...coerce(params)) as never,
      run: (sql, ...params) => {
        bunDb.query(sql).run(...coerce(params));
      },
    };
  }
  const nodeDb = db as NodeSyncDatabase;
  return {
    query: (sql, ...params) => nodeDb.prepare(sql).all(...coerce(params)) as never,
    run: (sql, ...params) => {
      nodeDb.prepare(sql).run(...coerce(params));
    },
  };
}

/**
 * A SqlFileSystem persisted to a SQLite file on disk (or `:memory:`). Uses the
 * platform built-in sync SQLite driver — no external dependency.
 */
export function nodeSqlFileSystem(
  dbPath: string,
  options?: SqlFileSystemFactoryOptions,
): SqlFileSystem {
  const db = openSyncDatabase(dbPath);
  return new SqlFileSystem({ backend: syncSqlBackend(db), ...options });
}
