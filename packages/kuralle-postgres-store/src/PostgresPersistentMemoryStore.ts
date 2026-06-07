import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from '@kuralle-agents/core';
import type { QueryResult } from 'pg';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PostgresPersistentMemoryStoreOptions = {
  client: PostgresClient;
  tableName?: string;
  autoMigrate?: boolean;
};

const defaultTable = 'working_memory_blocks';

const normalizeTableName = (tableName?: string): string => {
  const table = tableName ?? defaultTable;
  if (!/^[a-zA-Z0-9_.]+$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return table;
};

export class PostgresPersistentMemoryStore implements PersistentMemoryStore {
  private client: PostgresClient;
  private table: string;
  private ready: Promise<void>;

  constructor(options: PostgresPersistentMemoryStoreOptions) {
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
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        char_limit INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (scope, owner, key)
      )`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS idx_${this.table}_scope_owner
       ON ${this.table} (scope, owner)`,
    );
  }

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT content, char_limit, updated_at
       FROM ${this.table}
       WHERE scope = $1 AND owner = $2 AND key = $3`,
      [scope, owner, key],
    );
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0] as {
      content: string;
      char_limit: number;
      updated_at: Date | string;
    };
    return {
      key,
      scope,
      content: row.content,
      charLimit: row.char_limit,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    await this.ready;
    const updatedAt = block.updatedAt ?? new Date().toISOString();
    await this.client.query(
      `INSERT INTO ${this.table} (scope, owner, key, content, char_limit, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope, owner, key) DO UPDATE SET
         content = EXCLUDED.content,
         char_limit = EXCLUDED.char_limit,
         updated_at = EXCLUDED.updated_at`,
      [block.scope, owner, block.key, block.content, block.charLimit, updatedAt],
    );
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    await this.ready;
    await this.client.query(
      `DELETE FROM ${this.table} WHERE scope = $1 AND owner = $2 AND key = $3`,
      [scope, owner, key],
    );
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    await this.ready;
    const result = await this.client.query(
      `SELECT key FROM ${this.table}
       WHERE scope = $1 AND owner = $2
       ORDER BY key`,
      [scope, owner],
    );
    return result.rows.map((row) => (row as { key: string }).key);
  }
}
