import type {
  ExtractedValue,
  ExtractedValueStore,
  MemoryBlockScope,
} from '@kuralle-agents/core';
import type { QueryResult } from 'pg';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PostgresExtractedValueStoreOptions = {
  client: PostgresClient;
  tableName?: string;
  autoMigrate?: boolean;
};

const defaultTable = 'extracted_values';

const normalizeTableName = (tableName?: string): string => {
  const table = tableName ?? defaultTable;
  if (!/^[a-zA-Z0-9_.]+$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return table;
};

export class PostgresExtractedValueStore implements ExtractedValueStore {
  private client: PostgresClient;
  private table: string;
  private ready: Promise<void>;

  constructor(options: PostgresExtractedValueStoreOptions) {
    this.client = options.client;
    this.table = normalizeTableName(options.tableName);
    const autoMigrate = options.autoMigrate ?? true;
    this.ready = autoMigrate ? this.init() : Promise.resolve();
  }

  private async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        scope TEXT NOT NULL,
        owner TEXT NOT NULL,
        slug TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, owner, slug)
      )`,
    );
  }

  async load(
    scope: MemoryBlockScope,
    owner: string,
    slug: string,
  ): Promise<ExtractedValue | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT value FROM ${this.table}
       WHERE scope = $1 AND owner = $2 AND slug = $3`,
      [scope, owner, slug],
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0] as { value: string };
    return JSON.parse(row.value) as ExtractedValue;
  }

  async save(value: ExtractedValue, owner: string): Promise<void> {
    await this.ready;
    const payload = JSON.stringify(value);
    await this.client.query(
      `INSERT INTO ${this.table} (scope, owner, slug, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, owner, slug) DO UPDATE SET
         value = EXCLUDED.value`,
      [value.scope, owner, value.slug, payload],
    );
  }

  async delete(scope: MemoryBlockScope, owner: string, slug: string): Promise<void> {
    await this.ready;
    await this.client.query(
      `DELETE FROM ${this.table} WHERE scope = $1 AND owner = $2 AND slug = $3`,
      [scope, owner, slug],
    );
  }
}
