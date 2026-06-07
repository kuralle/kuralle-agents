import type { SqlExecutor } from './types.js';

type SqlStorageExec = {
  exec: (query: string, ...params: unknown[]) => unknown;
};

function rowsFromExecResult<T>(result: unknown): T[] {
  if (result && typeof result === 'object') {
    const cursor = result as { toArray?: () => T[] };
    if (typeof cursor.toArray === 'function') {
      return cursor.toArray();
    }
    if (Symbol.iterator in cursor) {
      return [...(result as Iterable<T>)];
    }
  }
  return [];
}

/** Wrap DO `ctx.storage.sql.exec` as the tagged-template `SqlExecutor` shape. */
export function createSqlExecutor(storageSql: SqlStorageExec): SqlExecutor {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? '?' : ''),
      '',
    );
    return rowsFromExecResult(storageSql.exec(query, ...values));
  }) as SqlExecutor;
}
