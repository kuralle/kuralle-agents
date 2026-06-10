/**
 * Minimal tagged-template SQL executor contract.
 *
 * Structurally identical to `SqlExecutor` in `@kuralle-agents/cf-agent`
 * (Durable Object `ctx.storage.sql.exec` wrapped by `createSqlExecutor`),
 * and trivially implementable over `bun:sqlite` / `better-sqlite3` for
 * Node-side persistence. Declared here so `@kuralle-agents/rag` stays
 * dependency-free of the Cloudflare package.
 */
export type SqlExecutor = <T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

/**
 * Run a dynamically-built query through a tagged-template `SqlExecutor`.
 * `query` uses `?` for each positional parameter. Needed because table
 * names cannot be bound parameters in SQL.
 */
export function execSql<T = unknown>(
  sql: SqlExecutor,
  query: string,
  params: unknown[] = [],
): T[] {
  const parts = query.split('?');
  if (parts.length !== params.length + 1) {
    throw new Error(
      `execSql: query has ${parts.length - 1} placeholders but ${params.length} params`,
    );
  }
  const strings = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
  return sql<T>(strings, ...params);
}

/** Validate a SQL identifier (table name) — interpolated, never bound. */
export function assertSqlIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: '${name}'`);
  }
  return name;
}
