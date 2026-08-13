import {
  FlowDefinitionConflictError,
  FlowDefinitionNameMismatchError,
  FlowDefinitionNotFoundError,
  matchesFlowDefinitionListFilter,
  reviveFlowDefinitionVersion,
  stampNewFlowDefinitionVersion,
  type CreateVersionOptions,
  type FlowDefinitionListFilter,
  type FlowDefinitionVersion,
  type FlowDefinitionsStore,
  type FlowDefinition,
} from '@kuralle-agents/core';
import type { QueryResult } from 'pg';

type PostgresClient = {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
};

export type PostgresFlowDefinitionsStoreOptions = {
  client: PostgresClient;
  tableName?: string;
  autoMigrate?: boolean;
};

const defaultTable = 'kuralle_flow_definition_versions';

const normalizeTableName = (tableName?: string): string => {
  const table = tableName ?? defaultTable;
  if (!/^[a-zA-Z0-9_.]+$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  return table;
};

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

type VersionRow = {
  version_id: string;
  name: string;
  description: string;
  definition: FlowDefinition | string;
  digest: string;
  status: FlowDefinitionVersion['status'];
  author_id: string | null;
  created_at: Date | string;
};

function fromRow(row: VersionRow): FlowDefinitionVersion {
  const definition =
    typeof row.definition === 'string'
      ? (JSON.parse(row.definition) as FlowDefinition)
      : row.definition;
  return reviveFlowDefinitionVersion({
    versionId: row.version_id,
    name: row.name,
    description: row.description,
    definition,
    digest: row.digest,
    status: row.status,
    authorId: row.author_id,
    createdAt: row.created_at,
  });
}

export class PostgresFlowDefinitionsStore implements FlowDefinitionsStore {
  private readonly client: PostgresClient;
  private readonly table: string;
  private readonly ready: Promise<void>;

  constructor(options: PostgresFlowDefinitionsStoreOptions) {
    this.client = options.client;
    this.table = normalizeTableName(options.tableName);
    this.ready = (options.autoMigrate ?? true) ? this.init() : Promise.resolve();
  }

  private async init(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        version_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        definition JSONB NOT NULL,
        digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
        author_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (name, digest)
      )`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.table.replace(/\./g, '_')}_name_status_idx
       ON ${this.table} (name, status)`,
    );
  }

  async createVersion(
    def: FlowDefinition,
    options?: CreateVersionOptions,
  ): Promise<FlowDefinitionVersion> {
    await this.ready;
    const row = await stampNewFlowDefinitionVersion(def, options);
    try {
      await this.client.query(
        `INSERT INTO ${this.table}
          (version_id, name, description, definition, digest, status, author_id, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
        [
          row.versionId,
          row.name,
          row.description,
          JSON.stringify(row.definition),
          row.digest,
          row.status,
          row.authorId ?? null,
          row.createdAt,
        ],
      );
    } catch (error) {
      if (pgCode(error) === '23505') {
        throw new FlowDefinitionConflictError(row.name, row.digest);
      }
      throw error;
    }
    return row;
  }

  async setActive(name: string, versionId: string): Promise<FlowDefinitionVersion> {
    await this.ready;
    const target = await this.getVersion(versionId);
    if (!target) throw new FlowDefinitionNotFoundError({ versionId });
    if (target.name !== name) {
      throw new FlowDefinitionNameMismatchError(versionId, name, target.name);
    }
    await this.client.query(
      `UPDATE ${this.table}
       SET status = CASE WHEN version_id = $2 THEN 'active' ELSE 'superseded' END
       WHERE name = $1`,
      [name, versionId],
    );
    const published = await this.getVersion(versionId);
    if (!published) throw new FlowDefinitionNotFoundError({ versionId });
    return published;
  }

  async getActive(name: string): Promise<FlowDefinitionVersion | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT version_id, name, description, definition, digest, status, author_id, created_at
       FROM ${this.table}
       WHERE name = $1 AND status = 'active'`,
      [name],
    );
    const row = result.rows[0] as VersionRow | undefined;
    return row ? fromRow(row) : null;
  }

  async getVersion(versionId: string): Promise<FlowDefinitionVersion | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT version_id, name, description, definition, digest, status, author_id, created_at
       FROM ${this.table}
       WHERE version_id = $1`,
      [versionId],
    );
    const row = result.rows[0] as VersionRow | undefined;
    return row ? fromRow(row) : null;
  }

  async list(filter?: FlowDefinitionListFilter): Promise<FlowDefinitionVersion[]> {
    await this.ready;
    const result = await this.client.query(
      `SELECT version_id, name, description, definition, digest, status, author_id, created_at
       FROM ${this.table}`,
    );
    const all = (result.rows as VersionRow[]).map(fromRow);
    return all
      .filter(row => matchesFlowDefinitionListFilter(row, all, filter))
      .sort(compareVersions);
  }

  async archive(name: string): Promise<void> {
    await this.ready;
    const result = await this.client.query(
      `UPDATE ${this.table} SET status = 'archived' WHERE name = $1`,
      [name],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new FlowDefinitionNotFoundError({ name });
    }
  }
}

function compareVersions(a: FlowDefinitionVersion, b: FlowDefinitionVersion): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return b.versionId.localeCompare(a.versionId);
}
