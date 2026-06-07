import type {
  MemoryBlockScope,
  PersistentMemoryBlock,
  PersistentMemoryStore,
} from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

export class SqlPersistentMemoryStore implements PersistentMemoryStore {
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
      CREATE TABLE IF NOT EXISTS working_memory_blocks (
        scope TEXT NOT NULL,
        owner TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        char_limit INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, owner, key)
      )
    `;
    this.initialized = true;
  }

  async loadBlock(
    scope: MemoryBlockScope,
    owner: string,
    key: string,
  ): Promise<PersistentMemoryBlock | null> {
    this.ensureTable();
    const rows = this.sql<{
      content: string;
      char_limit: number;
      updated_at: string;
    }>`
      SELECT content, char_limit, updated_at
      FROM working_memory_blocks
      WHERE scope = ${scope} AND owner = ${owner} AND key = ${key}
    `;
    if (!rows || rows.length === 0) {
      return null;
    }
    const row = rows[0];
    return {
      key,
      scope,
      content: row.content,
      charLimit: row.char_limit,
      updatedAt: row.updated_at,
    };
  }

  async saveBlock(block: PersistentMemoryBlock, owner: string): Promise<void> {
    this.ensureTable();
    const updatedAt = block.updatedAt ?? new Date().toISOString();
    this.sql`
      INSERT INTO working_memory_blocks (scope, owner, key, content, char_limit, updated_at)
      VALUES (${block.scope}, ${owner}, ${block.key}, ${block.content}, ${block.charLimit}, ${updatedAt})
      ON CONFLICT(scope, owner, key) DO UPDATE SET
        content = excluded.content,
        char_limit = excluded.char_limit,
        updated_at = excluded.updated_at
    `;
  }

  async deleteBlock(scope: MemoryBlockScope, owner: string, key: string): Promise<void> {
    this.ensureTable();
    this.sql`
      DELETE FROM working_memory_blocks
      WHERE scope = ${scope} AND owner = ${owner} AND key = ${key}
    `;
  }

  async listBlocks(scope: MemoryBlockScope, owner: string): Promise<string[]> {
    this.ensureTable();
    const rows = this.sql<{ key: string }>`
      SELECT key FROM working_memory_blocks
      WHERE scope = ${scope} AND owner = ${owner}
      ORDER BY key
    `;
    return (rows ?? []).map((row) => row.key);
  }
}
