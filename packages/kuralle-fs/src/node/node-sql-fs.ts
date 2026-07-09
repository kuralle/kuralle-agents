// `nodeSqlFileSystem` — a persistent SqlFileSystem on the Node platform, backed
// by the built-in `node:sqlite` (Node >= 22.5). Node-only; lives behind the
// `@kuralle-agents/fs/node` subpath.
import { DatabaseSync } from 'node:sqlite';
import type { SqlBackend, SqlParam } from '../sql/types.js';
import { SqlFileSystem } from '../sql/sql-fs.js';
import type { SqlFileSystemFactoryOptions } from '../sql/factory.js';

// node:sqlite's SQLInputValue excludes `boolean`; coerce to 0/1 (SqlFileSystem
// never binds booleans, but the SqlBackend contract permits them).
function coerce(params: SqlParam[]): (string | number | null)[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function nodeSqlBackend(db: DatabaseSync): SqlBackend {
  return {
    query: (sql, ...params) => db.prepare(sql).all(...coerce(params)) as never,
    run: (sql, ...params) => {
      db.prepare(sql).run(...coerce(params));
    },
  };
}

/**
 * A SqlFileSystem persisted to a SQLite file on disk (or `:memory:`). Uses the
 * built-in `node:sqlite` — no external dependency.
 */
export function nodeSqlFileSystem(
  dbPath: string,
  options?: SqlFileSystemFactoryOptions,
): SqlFileSystem {
  const db = new DatabaseSync(dbPath);
  return new SqlFileSystem({ backend: nodeSqlBackend(db), ...options });
}
