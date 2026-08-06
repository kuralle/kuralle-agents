import { describe, it } from 'bun:test';
import { extractedValueStoreConformanceCases } from '@kuralle-agents/core';
import type { SqlExecutor } from '../types.js';
import { SqlExtractedValueStore } from '../SqlExtractedValueStore.js';

type Row = {
  scope: string;
  owner: string;
  slug: string;
  value: string;
};

function createFakeSqlExecutor(): SqlExecutor {
  const rows = new Map<string, Row>();

  const rowKey = (scope: string, owner: string, slug: string) =>
    `${scope}\u0000${owner}\u0000${slug}`;

  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').trim();

    if (query.includes('CREATE TABLE IF NOT EXISTS extracted_values')) {
      return [];
    }

    if (query.includes('SELECT value')) {
      const [scope, owner, slug] = values as [string, string, string];
      const row = rows.get(rowKey(scope, owner, slug));
      return row ? [{ value: row.value }] : [];
    }

    if (query.includes('INSERT INTO extracted_values')) {
      const [scope, owner, slug, value] = values as [string, string, string, string];
      rows.set(rowKey(scope, owner, slug), { scope, owner, slug, value });
      return [];
    }

    if (query.includes('DELETE FROM extracted_values')) {
      const [scope, owner, slug] = values as [string, string, string];
      rows.delete(rowKey(scope, owner, slug));
      return [];
    }

    throw new Error(`Unhandled SQL: ${query}`);
  }) as SqlExecutor;
}

function makeStore() {
  return new SqlExtractedValueStore(createFakeSqlExecutor());
}

describe('SqlExtractedValueStore', () => {
  for (const c of extractedValueStoreConformanceCases) {
    it(c.name, async () => {
      await c.run(makeStore());
    });
  }
});
