import type {
  ExtractedValue,
  ExtractedValueStore,
  MemoryBlockScope,
} from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

export class SqlExtractedValueStore implements ExtractedValueStore {
  private sql: SqlExecutor;
  private initialized = false;

  constructor(sql: SqlExecutor) {
    this.sql = sql;
  }

  private ensureTable(): void {
    if (this.initialized) {
      return;
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS extracted_values (
        scope TEXT NOT NULL,
        owner TEXT NOT NULL,
        slug TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, owner, slug)
      )
    `;
    this.initialized = true;
  }

  async load(
    scope: MemoryBlockScope,
    owner: string,
    slug: string,
  ): Promise<ExtractedValue | null> {
    this.ensureTable();
    const rows = this.sql<{ value: string }>`
      SELECT value
      FROM extracted_values
      WHERE scope = ${scope} AND owner = ${owner} AND slug = ${slug}
    `;
    if (!rows || rows.length === 0) {
      return null;
    }
    return JSON.parse(rows[0].value) as ExtractedValue;
  }

  async save(value: ExtractedValue, owner: string): Promise<void> {
    this.ensureTable();
    const payload = JSON.stringify(value);
    this.sql`
      INSERT INTO extracted_values (scope, owner, slug, value)
      VALUES (${value.scope}, ${owner}, ${value.slug}, ${payload})
      ON CONFLICT(scope, owner, slug) DO UPDATE SET
        value = excluded.value
    `;
  }

  async delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void> {
    this.ensureTable();
    this.sql`
      DELETE FROM extracted_values
      WHERE scope = ${scope} AND owner = ${owner} AND slug = ${slug}
    `;
  }
}
