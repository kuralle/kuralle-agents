import { describe, it } from 'node:test';
import { extractedValueStoreConformanceCases } from '@kuralle-agents/core';
import { PostgresExtractedValueStore } from '../dist/PostgresExtractedValueStore.js';

function createMockPostgresClient() {
  const rows = new Map();

  const rowKey = (scope, owner, slug) => `${scope}\u0000${owner}\u0000${slug}`;

  return {
    rows,
    async query(text, params = []) {
      if (text.trim().startsWith('CREATE TABLE')) {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('SELECT value FROM')) {
        const [scope, owner, slug] = params;
        const row = rows.get(rowKey(scope, owner, slug));
        return { rows: row ? [{ value: row.value }] : [], rowCount: row ? 1 : 0 };
      }

      if (text.trim().startsWith('INSERT')) {
        const [scope, owner, slug, value] = params;
        rows.set(rowKey(scope, owner, slug), { scope, owner, slug, value });
        return { rows: [], rowCount: 1 };
      }

      if (text.trim().startsWith('DELETE')) {
        const [scope, owner, slug] = params;
        rows.delete(rowKey(scope, owner, slug));
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled query: ${text}`);
    },
  };
}

function makeStore() {
  return new PostgresExtractedValueStore({ client: createMockPostgresClient() });
}

describe('PostgresExtractedValueStore', () => {
  for (const c of extractedValueStoreConformanceCases) {
    it(c.name, async () => {
      await c.run(makeStore());
    });
  }
});
