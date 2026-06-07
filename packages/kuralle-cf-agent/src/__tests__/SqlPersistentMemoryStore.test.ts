import { describe, expect, it } from 'bun:test';
import type { SqlExecutor } from '../types.js';
import { SqlPersistentMemoryStore } from '../SqlPersistentMemoryStore.js';

type Row = {
  scope: string;
  owner: string;
  key: string;
  content: string;
  char_limit: number;
  updated_at: string;
};

function createFakeSqlExecutor(): SqlExecutor {
  const rows = new Map<string, Row>();
  let tableReady = false;

  const rowKey = (scope: string, owner: string, key: string) =>
    `${scope}:${owner}:${key}`;

  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').trim();

    if (query.includes('CREATE TABLE IF NOT EXISTS working_memory_blocks')) {
      tableReady = true;
      return [];
    }

    if (query.includes('SELECT content, char_limit, updated_at')) {
      const [scope, owner, key] = values as [string, string, string];
      const row = rows.get(rowKey(scope, owner, key));
      return row ? [row] : [];
    }

    if (query.includes('INSERT INTO working_memory_blocks')) {
      const [scope, owner, key, content, charLimit, updatedAt] = values as [
        string,
        string,
        string,
        string,
        number,
        string,
      ];
      rows.set(rowKey(scope, owner, key), {
        scope,
        owner,
        key,
        content,
        char_limit: charLimit,
        updated_at: updatedAt,
      });
      return [];
    }

    if (query.includes('DELETE FROM working_memory_blocks')) {
      const [scope, owner, key] = values as [string, string, string];
      rows.delete(rowKey(scope, owner, key));
      return [];
    }

    if (query.includes('SELECT key FROM working_memory_blocks')) {
      const [scope, owner] = values as [string, string];
      return [...rows.values()]
        .filter((row) => row.scope === scope && row.owner === owner)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((row) => ({ key: row.key }));
    }

    throw new Error(`Unhandled SQL: ${query}`);
  }) as SqlExecutor;
}

describe('SqlPersistentMemoryStore', () => {
  it('round-trips via fake SqlExecutor', async () => {
    const sql = createFakeSqlExecutor();
    const store = new SqlPersistentMemoryStore(sql);

    await store.saveBlock(
      { key: 'USER', scope: 'user', content: 'cf user', charLimit: 1000 },
      'alice',
    );
    const loaded = await store.loadBlock('user', 'alice', 'USER');
    expect(loaded?.content).toBe('cf user');
  });

  it('durability: fresh store instance reads prior write', async () => {
    const sql = createFakeSqlExecutor();
    const storeA = new SqlPersistentMemoryStore(sql);
    await storeA.saveBlock(
      { key: 'MEMORY', scope: 'agent', content: 'durable in do', charLimit: 2000 },
      'bot-1',
    );

    const storeB = new SqlPersistentMemoryStore(sql);
    const loaded = await storeB.loadBlock('agent', 'bot-1', 'MEMORY');
    expect(loaded?.content).toBe('durable in do');
  });
});
