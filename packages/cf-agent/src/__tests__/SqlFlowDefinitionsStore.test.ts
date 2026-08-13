import { describe, it } from 'bun:test';
import { flowDefinitionsStoreConformanceCases } from '@kuralle-agents/core/flows/definition/testing';
import type { SqlExecutor } from '../types.js';
import { SqlFlowDefinitionsStore } from '../SqlFlowDefinitionsStore.js';

type Row = {
  version_id: string;
  name: string;
  description: string;
  definition: string;
  digest: string;
  status: string;
  author_id: string | null;
  created_at: string;
};

function createFakeSqlExecutor(): SqlExecutor {
  const rows = new Map<string, Row>();
  const digestIndex = new Map<string, string>();

  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();

    if (query.startsWith('CREATE TABLE') || query.startsWith('CREATE INDEX')) {
      return [];
    }

    if (query.startsWith('INSERT INTO kuralle_flow_definition_versions')) {
      const [versionId, name, description, definition, digest, status, authorId, createdAt] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
      ];
      const digestKey = `${name}\0${digest}`;
      if (rows.has(versionId) || digestIndex.has(digestKey)) {
        throw new Error(
          'UNIQUE constraint failed: kuralle_flow_definition_versions.name, kuralle_flow_definition_versions.digest',
        );
      }
      digestIndex.set(digestKey, versionId);
      rows.set(versionId, {
        version_id: versionId,
        name,
        description,
        definition,
        digest,
        status,
        author_id: authorId,
        created_at: createdAt,
      });
      return [];
    }

    if (query.includes('WHERE version_id = ?')) {
      const row = rows.get(String(values[0]));
      return row ? [row] : [];
    }

    if (query.includes("AND status = 'active'")) {
      const name = String(values[0]);
      return [...rows.values()].filter(row => row.name === name && row.status === 'active');
    }

    if (query.startsWith('SELECT version_id FROM kuralle_flow_definition_versions WHERE name = ?')) {
      const name = String(values[0]);
      return [...rows.values()].filter(row => row.name === name).map(row => ({ version_id: row.version_id }));
    }

    if (query.startsWith('SELECT version_id, name, description, definition, digest, status, author_id, created_at FROM kuralle_flow_definition_versions')) {
      return [...rows.values()];
    }

    if (query.includes("SET status = CASE WHEN version_id = ? THEN 'active' ELSE 'superseded' END")) {
      const [versionId, name] = values as [string, string];
      for (const row of rows.values()) {
        if (row.name !== name) continue;
        row.status = row.version_id === versionId ? 'active' : 'superseded';
      }
      return [];
    }

    if (query.includes("SET status = 'archived' WHERE name = ?")) {
      const name = String(values[0]);
      for (const row of rows.values()) {
        if (row.name === name) row.status = 'archived';
      }
      return [];
    }

    if (query.startsWith('DELETE FROM kuralle_flow_definition_versions')) {
      rows.clear();
      digestIndex.clear();
      return [];
    }

    throw new Error(`Unhandled SQL: ${query}`);
  }) as SqlExecutor;
}

describe('SqlFlowDefinitionsStore conformance', () => {
  for (const testCase of flowDefinitionsStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(new SqlFlowDefinitionsStore(createFakeSqlExecutor()));
    });
  }
});
