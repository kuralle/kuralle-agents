import {
  FlowDefinitionConflictError,
  FlowDefinitionNameMismatchError,
  FlowDefinitionNotFoundError,
  matchesFlowDefinitionListFilter,
  reviveFlowDefinitionVersion,
  stampNewFlowDefinitionVersion,
  type CreateVersionOptions,
  type FlowDefinition,
  type FlowDefinitionListFilter,
  type FlowDefinitionVersion,
  type FlowDefinitionsStore,
} from '@kuralle-agents/core';
import type { SqlExecutor } from './types.js';

type VersionRow = {
  version_id: string;
  name: string;
  description: string;
  definition: string;
  digest: string;
  status: FlowDefinitionVersion['status'];
  author_id: string | null;
  created_at: string;
};

function fromRow(row: VersionRow): FlowDefinitionVersion {
  return reviveFlowDefinitionVersion({
    versionId: row.version_id,
    name: row.name,
    description: row.description,
    definition: JSON.parse(row.definition) as FlowDefinition,
    digest: row.digest,
    status: row.status,
    authorId: row.author_id,
    createdAt: row.created_at,
  });
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

export class SqlFlowDefinitionsStore implements FlowDefinitionsStore {
  constructor(private readonly sql: SqlExecutor) {
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_flow_definition_versions (
        version_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        definition TEXT NOT NULL,
        digest TEXT NOT NULL,
        status TEXT NOT NULL,
        author_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (name, digest)
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS kuralle_flow_definition_versions_name_status_idx
      ON kuralle_flow_definition_versions (name, status)
    `;
  }

  async createVersion(
    def: FlowDefinition,
    options?: CreateVersionOptions,
  ): Promise<FlowDefinitionVersion> {
    const row = await stampNewFlowDefinitionVersion(def, options);
    try {
      this.sql`
        INSERT INTO kuralle_flow_definition_versions
          (version_id, name, description, definition, digest, status, author_id, created_at)
        VALUES (
          ${row.versionId},
          ${row.name},
          ${row.description},
          ${JSON.stringify(row.definition)},
          ${row.digest},
          ${row.status},
          ${row.authorId ?? null},
          ${row.createdAt.toISOString()}
        )
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new FlowDefinitionConflictError(row.name, row.digest);
      }
      throw error;
    }
    return row;
  }

  async setActive(name: string, versionId: string): Promise<FlowDefinitionVersion> {
    const target = await this.getVersion(versionId);
    if (!target) throw new FlowDefinitionNotFoundError({ versionId });
    if (target.name !== name) {
      throw new FlowDefinitionNameMismatchError(versionId, name, target.name);
    }
    this.sql`
      UPDATE kuralle_flow_definition_versions
      SET status = CASE WHEN version_id = ${versionId} THEN 'active' ELSE 'superseded' END
      WHERE name = ${name}
    `;
    const published = await this.getVersion(versionId);
    if (!published) throw new FlowDefinitionNotFoundError({ versionId });
    return published;
  }

  async getActive(name: string): Promise<FlowDefinitionVersion | null> {
    const rows = this.sql<VersionRow>`
      SELECT version_id, name, description, definition, digest, status, author_id, created_at
      FROM kuralle_flow_definition_versions
      WHERE name = ${name} AND status = 'active'
    `;
    const row = rows[0];
    return row ? fromRow(row) : null;
  }

  async getVersion(versionId: string): Promise<FlowDefinitionVersion | null> {
    const rows = this.sql<VersionRow>`
      SELECT version_id, name, description, definition, digest, status, author_id, created_at
      FROM kuralle_flow_definition_versions
      WHERE version_id = ${versionId}
    `;
    const row = rows[0];
    return row ? fromRow(row) : null;
  }

  async list(filter?: FlowDefinitionListFilter): Promise<FlowDefinitionVersion[]> {
    const rows = this.sql<VersionRow>`
      SELECT version_id, name, description, definition, digest, status, author_id, created_at
      FROM kuralle_flow_definition_versions
    `;
    const all = rows.map(fromRow);
    return all
      .filter(row => matchesFlowDefinitionListFilter(row, all, filter))
      .sort(compareVersions);
  }

  async archive(name: string): Promise<void> {
    const existing = this.sql<{ version_id: string }>`
      SELECT version_id FROM kuralle_flow_definition_versions WHERE name = ${name}
    `;
    if (existing.length === 0) throw new FlowDefinitionNotFoundError({ name });
    this.sql`
      UPDATE kuralle_flow_definition_versions SET status = 'archived' WHERE name = ${name}
    `;
  }
}

function compareVersions(a: FlowDefinitionVersion, b: FlowDefinitionVersion): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return b.versionId.localeCompare(a.versionId);
}
