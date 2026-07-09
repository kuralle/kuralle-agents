import { describe } from 'bun:test';
import {
  runPersistentMemoryDurabilityContract,
  runPersistentMemoryStoreContract,
} from '@kuralle-agents/core/memory/testing';
import { PostgresPersistentMemoryStore } from '../PostgresPersistentMemoryStore.js';

type Row = {
  scope: string;
  owner: string;
  key: string;
  content: string;
  char_limit: number;
  updated_at: string;
};

function createFakePostgresClient() {
  const rows = new Map<string, Row>();

  const rowKey = (scope: string, owner: string, key: string) =>
    `${scope}:${owner}:${key}`;

  return {
    rows,
    client: {
      async query(text: string, params: unknown[] = []) {
        if (text.includes('CREATE TABLE')) {
          return { rows: [] };
        }
        if (text.includes('CREATE INDEX')) {
          return { rows: [] };
        }
        if (text.startsWith('SELECT content')) {
          const [scope, owner, key] = params as [string, string, string];
          const row = rows.get(rowKey(scope, owner, key));
          return { rows: row ? [row] : [] };
        }
        if (text.startsWith('INSERT INTO')) {
          const [scope, owner, key, content, charLimit, updatedAt] = params as [
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
          return { rows: [] };
        }
        if (text.startsWith('DELETE FROM')) {
          const [scope, owner, key] = params as [string, string, string];
          rows.delete(rowKey(scope, owner, key));
          return { rows: [] };
        }
        if (text.startsWith('SELECT key FROM')) {
          const [scope, owner] = params as [string, string];
          const keys = [...rows.values()]
            .filter((row) => row.scope === scope && row.owner === owner)
            .map((row) => row.key)
            .sort();
          return { rows: keys.map((key) => ({ key })) };
        }
        throw new Error(`Unhandled query: ${text}`);
      },
    },
  };
}

runPersistentMemoryStoreContract(async () => {
  const { client } = createFakePostgresClient();
  return new PostgresPersistentMemoryStore({ client });
});

runPersistentMemoryDurabilityContract(async () => {
  const { client } = createFakePostgresClient();
  return {
    storeA: new PostgresPersistentMemoryStore({ client, autoMigrate: false }),
    storeB: new PostgresPersistentMemoryStore({ client, autoMigrate: false }),
  };
});

describe('PostgresPersistentMemoryStore fake client', () => {
  // contract + durability registered above
});
