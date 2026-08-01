import {
  DeploymentError,
  assertArtifactCompatible,
  canonicalJson,
  createArtifact,
  selectReleaseAllocation,
  validateArtifact,
  validateThreadAssignmentRequest,
  type AgentDraft,
  type AgentEntity,
  type AgentRelease,
  type AgentVersion,
  type ArtifactInputV1,
  type DeploymentStore,
  type PublishDraftRequest,
  type RuntimeRevision,
  type ThreadAssignmentRequest,
  type ThreadPin,
} from '@kuralle-agents/deployment';

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<QueryResultLike>;
  release?(): void;
}

interface PgPoolLike extends PgClientLike {
  connect?(): Promise<PgClientLike>;
}

export interface PostgresDeploymentStoreOptions {
  client: PgPoolLike;
  tablePrefix?: string;
  /** Existing Postgres schema to use. Kuralle never creates the schema itself. */
  schema?: string;
  /** Opt-in convenience for dedicated databases and local tests. Defaults to false. */
  autoMigrate?: boolean;
}

export interface PostgresDeploymentTables {
  entities: string;
  drafts: string;
  versions: string;
  runtimes: string;
  releases: string;
  allocations: string;
  activeReleases: string;
  pins: string;
}

export interface PostgresDeploymentSchemaOptions {
  tablePrefix?: string;
  schema?: string;
}

function identifier(value: string, label: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Invalid deployment ${label}: ${value}`);
  return value;
}

export function postgresDeploymentTables(
  options: PostgresDeploymentSchemaOptions = {},
): PostgresDeploymentTables {
  const prefix = identifier(options.tablePrefix ?? 'kuralle_deploy', 'table prefix');
  const qualify = (name: string) => options.schema
    ? `${identifier(options.schema, 'schema')}.${name}`
    : name;
  return {
    entities: qualify(`${prefix}_agent_entities`),
    drafts: qualify(`${prefix}_agent_drafts`),
    versions: qualify(`${prefix}_agent_versions`),
    runtimes: qualify(`${prefix}_runtime_revisions`),
    releases: qualify(`${prefix}_releases`),
    allocations: qualify(`${prefix}_release_allocations`),
    activeReleases: qualify(`${prefix}_active_releases`),
    pins: qualify(`${prefix}_thread_pins`),
  };
}

export function postgresDeploymentMigrationStatements(
  options: PostgresDeploymentSchemaOptions = {},
): readonly string[] {
  const t = postgresDeploymentTables(options);
  const prefix = identifier(options.tablePrefix ?? 'kuralle_deploy', 'table prefix');
  return [
    `CREATE TABLE IF NOT EXISTS ${t.entities} (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, slug TEXT NOT NULL, status TEXT NOT NULL,
      owner_id TEXT NOT NULL, visibility TEXT NOT NULL, active_version_id TEXT,
      created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,slug))`,
    `CREATE TABLE IF NOT EXISTS ${t.drafts} (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, agent_entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL, definition JSONB NOT NULL, updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tenant_id,id),
      FOREIGN KEY (tenant_id,agent_entity_id) REFERENCES ${t.entities}(tenant_id,id))`,
    `CREATE TABLE IF NOT EXISTS ${t.versions} (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, agent_entity_id TEXT NOT NULL,
      version INTEGER NOT NULL, digest CHAR(64) NOT NULL, artifact JSONB NOT NULL,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,agent_entity_id,version),
      FOREIGN KEY (tenant_id,agent_entity_id) REFERENCES ${t.entities}(tenant_id,id))`,
    `CREATE TABLE IF NOT EXISTS ${t.runtimes} (
      id TEXT PRIMARY KEY, definition JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${t.releases} (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, agent_entity_id TEXT NOT NULL,
      environment TEXT NOT NULL, branch TEXT, created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,agent_entity_id)
      REFERENCES ${t.entities}(tenant_id,id))`,
    `CREATE TABLE IF NOT EXISTS ${t.allocations} (
      tenant_id TEXT NOT NULL, release_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      agent_version_id TEXT NOT NULL, runtime_revision_id TEXT NOT NULL, weight INTEGER NOT NULL,
      PRIMARY KEY (tenant_id,release_id,ordinal), FOREIGN KEY (tenant_id,release_id)
      REFERENCES ${t.releases}(tenant_id,id), FOREIGN KEY (tenant_id,agent_version_id)
      REFERENCES ${t.versions}(tenant_id,id), FOREIGN KEY (runtime_revision_id)
      REFERENCES ${t.runtimes}(id))`,
    `CREATE TABLE IF NOT EXISTS ${t.activeReleases} (
      tenant_id TEXT NOT NULL, agent_entity_id TEXT NOT NULL, environment TEXT NOT NULL,
      release_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (tenant_id,agent_entity_id,environment), FOREIGN KEY (tenant_id,release_id)
      REFERENCES ${t.releases}(tenant_id,id))`,
    `CREATE TABLE IF NOT EXISTS ${t.pins} (
      thread_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_entity_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL, artifact_digest CHAR(64) NOT NULL,
      runtime_revision_id TEXT NOT NULL, release_id TEXT NOT NULL, branch TEXT,
      environment TEXT NOT NULL, config_generation INTEGER NOT NULL,
      secret_generation INTEGER NOT NULL, assigned_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (tenant_id,agent_version_id) REFERENCES ${t.versions}(tenant_id,id),
      FOREIGN KEY (runtime_revision_id) REFERENCES ${t.runtimes}(id),
      FOREIGN KEY (tenant_id,release_id) REFERENCES ${t.releases}(tenant_id,id))`,
    `CREATE INDEX IF NOT EXISTS ${prefix}_thread_pins_tenant_agent_idx
      ON ${t.pins}(tenant_id,agent_entity_id,environment)`,
  ];
}

export function postgresDeploymentMigrationSql(
  options: PostgresDeploymentSchemaOptions = {},
): string {
  return `${postgresDeploymentMigrationStatements(options).join(';\n\n')};\n`;
}

function json(value: unknown): string {
  return canonicalJson(value);
}

function parsed<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function code(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function conflict(message: string): never {
  throw new DeploymentError('CONFLICT', message);
}

function notFound(message: string): never {
  throw new DeploymentError('NOT_FOUND', message);
}

function accessDenied(): never {
  throw new DeploymentError('ACCESS_DENIED', 'resource is not accessible in this tenant');
}

function entityFrom(row: Record<string, unknown>): AgentEntity {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    slug: String(row.slug),
    status: row.status as AgentEntity['status'],
    ownerId: String(row.owner_id),
    visibility: row.visibility as AgentEntity['visibility'],
    activeVersionId: row.active_version_id ? String(row.active_version_id) : undefined,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function draftFrom(row: Record<string, unknown>): AgentDraft {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    agentEntityId: String(row.agent_entity_id),
    revision: Number(row.revision),
    definition: parsed<AgentDraft['definition']>(row.definition),
    updatedBy: String(row.updated_by),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function releaseFrom(
  row: Record<string, unknown>,
  allocations: AgentRelease['allocations'],
): AgentRelease {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    agentEntityId: String(row.agent_entity_id),
    environment: String(row.environment),
    branch: row.branch ? String(row.branch) : undefined,
    allocations,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function pinFrom(row: Record<string, unknown>): ThreadPin {
  return {
    tenantId: String(row.tenant_id),
    threadId: String(row.thread_id),
    agentEntityId: String(row.agent_entity_id),
    agentVersionId: String(row.agent_version_id),
    artifactDigest: String(row.artifact_digest),
    runtimeRevisionId: String(row.runtime_revision_id),
    releaseId: String(row.release_id),
    branch: row.branch ? String(row.branch) : undefined,
    environment: String(row.environment),
    configGeneration: Number(row.config_generation),
    secretGeneration: Number(row.secret_generation),
    assignedAt: new Date(row.assigned_at as string | Date).toISOString(),
  };
}

export class PostgresDeploymentStore implements DeploymentStore {
  private readonly client: PgPoolLike;
  private readonly tablePrefix: string;
  private readonly schema?: string;
  private readonly table: PostgresDeploymentTables;
  private readonly ready: Promise<void>;

  constructor(options: PostgresDeploymentStoreOptions) {
    this.client = options.client;
    this.tablePrefix = options.tablePrefix ?? 'kuralle_deploy';
    this.schema = options.schema;
    this.table = postgresDeploymentTables({ tablePrefix: this.tablePrefix, schema: this.schema });
    this.ready = options.autoMigrate ? this.migrate() : Promise.resolve();
  }

  async createEntity(entity: AgentEntity): Promise<void> {
    await this.ready;
    try {
      await this.client.query(
        `INSERT INTO ${this.table.entities}
          (tenant_id, id, slug, status, owner_id, visibility, active_version_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [entity.tenantId, entity.id, entity.slug, entity.status, entity.ownerId,
          entity.visibility, entity.activeVersionId ?? null, entity.createdAt],
      );
    } catch (error) {
      if (code(error) === '23505') conflict('agent entity already exists');
      throw error;
    }
  }

  async getEntity(tenantId: string, entityId: string): Promise<AgentEntity | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT * FROM ${this.table.entities} WHERE tenant_id = $1 AND id = $2`,
      [tenantId, entityId],
    );
    return result.rows[0] ? entityFrom(result.rows[0]) : null;
  }

  async saveDraft(draft: AgentDraft, expectedRevision: number): Promise<AgentDraft> {
    await this.ready;
    const definition = json(draft.definition);
    if (expectedRevision === 0) {
      const inserted = await this.client.query(
        `INSERT INTO ${this.table.drafts}
          (tenant_id,id,agent_entity_id,revision,definition,updated_by,updated_at)
         VALUES ($1,$2,$3,1,$4::jsonb,$5,$6)
         ON CONFLICT (tenant_id,id) DO NOTHING RETURNING *`,
        [draft.tenantId, draft.id, draft.agentEntityId, definition, draft.updatedBy, draft.updatedAt],
      );
      if (inserted.rows[0]) return draftFrom(inserted.rows[0]);
    } else {
      const updated = await this.client.query(
        `UPDATE ${this.table.drafts}
         SET definition=$5::jsonb, updated_by=$6, updated_at=$7, revision=revision+1
         WHERE tenant_id=$1 AND id=$2 AND agent_entity_id=$3 AND revision=$4
         RETURNING *`,
        [draft.tenantId, draft.id, draft.agentEntityId, expectedRevision,
          definition, draft.updatedBy, draft.updatedAt],
      );
      if (updated.rows[0]) return draftFrom(updated.rows[0]);
    }
    const current = await this.getDraft(draft.tenantId, draft.id);
    if (!current) notFound('agent draft does not exist');
    conflict(`draft revision changed: expected ${expectedRevision}, received ${current.revision}`);
  }

  async getDraft(tenantId: string, draftId: string): Promise<AgentDraft | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT * FROM ${this.table.drafts} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, draftId],
    );
    return result.rows[0] ? draftFrom(result.rows[0]) : null;
  }

  async publishDraft(request: PublishDraftRequest): Promise<AgentVersion> {
    const draft = await this.getDraft(request.tenantId, request.draftId);
    if (!draft) notFound('agent draft does not exist');
    if (draft.revision !== request.draftRevision) {
      conflict(`draft revision changed: expected ${request.draftRevision}, received ${draft.revision}`);
    }
    const artifact = await createArtifact(draft.definition as ArtifactInputV1);
    const version: AgentVersion = {
      id: request.versionId,
      tenantId: request.tenantId,
      agentEntityId: draft.agentEntityId,
      version: request.version,
      artifact,
      createdBy: request.createdBy,
      createdAt: request.createdAt,
    };
    await this.createVersion(version);
    return version;
  }

  async createVersion(version: AgentVersion): Promise<void> {
    await this.ready;
    const artifact = await validateArtifact(version.artifact);
    try {
      await this.client.query(
        `INSERT INTO ${this.table.versions}
          (tenant_id,id,agent_entity_id,version,digest,artifact,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [version.tenantId, version.id, version.agentEntityId, version.version,
          artifact.digest, json(artifact), version.createdBy, version.createdAt],
      );
    } catch (error) {
      if (code(error) === '23505') conflict('agent version already exists');
      if (code(error) === '23503') notFound('agent entity does not exist');
      throw error;
    }
  }

  async getVersion(tenantId: string, versionId: string): Promise<AgentVersion | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT * FROM ${this.table.versions} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, versionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      agentEntityId: String(row.agent_entity_id),
      version: Number(row.version),
      artifact: await validateArtifact(parsed(row.artifact)),
      createdBy: String(row.created_by),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    };
  }

  async registerRuntime(revision: RuntimeRevision): Promise<void> {
    await this.ready;
    try {
      await this.client.query(
        `INSERT INTO ${this.table.runtimes} (id,definition,created_at) VALUES ($1,$2::jsonb,$3)`,
        [revision.id, json(revision), revision.createdAt],
      );
    } catch (error) {
      if (code(error) === '23505') conflict('runtime revision already exists');
      throw error;
    }
  }

  async createRelease(release: AgentRelease): Promise<void> {
    await this.ready;
    if (release.allocations.length === 0) {
      throw new DeploymentError('RELEASE_INVALID', 'release must contain at least one allocation');
    }
    const total = release.allocations.reduce((sum, allocation) => sum + allocation.weight, 0);
    if (total !== 10_000 || release.allocations.some(item => !Number.isSafeInteger(item.weight) || item.weight <= 0)) {
      throw new DeploymentError('RELEASE_INVALID', 'release weights must be positive integers totaling 10000');
    }
    try {
      await this.transaction(async client => {
        const entity = await client.query(
          `SELECT id FROM ${this.table.entities} WHERE tenant_id=$1 AND id=$2`,
          [release.tenantId, release.agentEntityId],
        );
        if (!entity.rows[0]) notFound('agent entity does not exist');
        for (const allocation of release.allocations) {
          const versionResult = await client.query(
            `SELECT artifact,agent_entity_id FROM ${this.table.versions} WHERE tenant_id=$1 AND id=$2`,
            [release.tenantId, allocation.agentVersionId],
          );
          const versionRow = versionResult.rows[0];
          if (!versionRow || String(versionRow.agent_entity_id) !== release.agentEntityId) {
            throw new DeploymentError('RELEASE_INVALID', 'release references an inaccessible agent version');
          }
          const runtimeResult = await client.query(
            `SELECT definition FROM ${this.table.runtimes} WHERE id=$1`,
            [allocation.runtimeRevisionId],
          );
          if (!runtimeResult.rows[0]) {
            throw new DeploymentError('RELEASE_INVALID', 'release references an unknown runtime revision');
          }
          try {
            assertArtifactCompatible(
              await validateArtifact(parsed(versionRow.artifact)),
              parsed<RuntimeRevision>(runtimeResult.rows[0].definition),
            );
          } catch (error) {
            throw new DeploymentError(
              'RELEASE_INVALID',
              error instanceof Error ? error.message : 'runtime is incompatible with the artifact',
            );
          }
        }
        await client.query(
          `INSERT INTO ${this.table.releases}
            (tenant_id,id,agent_entity_id,environment,branch,created_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [release.tenantId, release.id, release.agentEntityId, release.environment,
            release.branch ?? null, release.createdAt],
        );
        for (let index = 0; index < release.allocations.length; index += 1) {
          const allocation = release.allocations[index]!;
          await client.query(
            `INSERT INTO ${this.table.allocations}
              (tenant_id,release_id,ordinal,agent_version_id,runtime_revision_id,weight)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [release.tenantId, release.id, index, allocation.agentVersionId,
              allocation.runtimeRevisionId, allocation.weight],
          );
        }
      });
    } catch (error) {
      if (code(error) === '23505') conflict('release already exists');
      if (code(error) === '23503') {
        throw new DeploymentError('RELEASE_INVALID', 'release references an inaccessible record');
      }
      throw error;
    }
  }

  async routeTrafficTo(tenantId: string, releaseId: string): Promise<void> {
    await this.ready;
    const result = await this.client.query(
      `SELECT * FROM ${this.table.releases} WHERE tenant_id=$1 AND id=$2`,
      [tenantId, releaseId],
    );
    const release = result.rows[0];
    if (!release) notFound('release does not exist');
    await this.client.query(
      `INSERT INTO ${this.table.activeReleases}
        (tenant_id,agent_entity_id,environment,release_id,updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (tenant_id,agent_entity_id,environment)
       DO UPDATE SET release_id=EXCLUDED.release_id, updated_at=NOW()`,
      [tenantId, release.agent_entity_id, release.environment, releaseId],
    );
  }

  async assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin> {
    await this.ready;
    validateThreadAssignmentRequest(request);
    return this.transaction(async client => {
      const existing = await client.query(
        `SELECT * FROM ${this.table.pins} WHERE thread_id=$1 FOR UPDATE`,
        [request.threadId],
      );
      if (existing.rows[0]) return this.verifyExistingPin(pinFrom(existing.rows[0]), request);
      const active = await client.query(
        `SELECT r.* FROM ${this.table.activeReleases} a
         JOIN ${this.table.releases} r ON r.tenant_id=a.tenant_id AND r.id=a.release_id
         WHERE a.tenant_id=$1 AND a.agent_entity_id=$2 AND a.environment=$3`,
        [request.tenantId, request.agentEntityId, request.environment],
      );
      const releaseRow = active.rows[0];
      if (!releaseRow) notFound('no active release exists for this agent and environment');
      const allocationRows = await client.query(
        `SELECT agent_version_id,runtime_revision_id,weight
         FROM ${this.table.allocations} WHERE tenant_id=$1 AND release_id=$2 ORDER BY ordinal`,
        [request.tenantId, releaseRow.id],
      );
      const allocations = allocationRows.rows.map(row => ({
        agentVersionId: String(row.agent_version_id),
        runtimeRevisionId: String(row.runtime_revision_id),
        weight: Number(row.weight),
      }));
      const release = releaseFrom(releaseRow, allocations);
      const allocation = await selectReleaseAllocation(allocations, [
        request.tenantId,
        request.environment,
        request.agentEntityId,
        release.id,
        request.threadId,
      ]);
      const version = await client.query(
        `SELECT digest FROM ${this.table.versions} WHERE tenant_id=$1 AND id=$2`,
        [request.tenantId, allocation.agentVersionId],
      );
      if (!version.rows[0]) notFound('assigned agent version does not exist');
      const pin: ThreadPin = {
        tenantId: request.tenantId,
        threadId: request.threadId,
        agentEntityId: request.agentEntityId,
        agentVersionId: allocation.agentVersionId,
        artifactDigest: String(version.rows[0].digest),
        runtimeRevisionId: allocation.runtimeRevisionId,
        releaseId: release.id,
        branch: release.branch,
        environment: request.environment,
        configGeneration: request.configGeneration ?? 1,
        secretGeneration: request.secretGeneration ?? 1,
        assignedAt: request.assignedAt ?? new Date().toISOString(),
      };
      try {
        const inserted = await client.query(
          `INSERT INTO ${this.table.pins}
            (thread_id,tenant_id,agent_entity_id,agent_version_id,artifact_digest,
             runtime_revision_id,release_id,branch,environment,config_generation,
             secret_generation,assigned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [pin.threadId, pin.tenantId, pin.agentEntityId, pin.agentVersionId, pin.artifactDigest,
            pin.runtimeRevisionId, pin.releaseId, pin.branch ?? null, pin.environment,
            pin.configGeneration, pin.secretGeneration, pin.assignedAt],
        );
        return pinFrom(inserted.rows[0]!);
      } catch (error) {
        if (code(error) !== '23505') throw error;
        const raced = await client.query(
          `SELECT * FROM ${this.table.pins} WHERE thread_id=$1`,
          [request.threadId],
        );
        if (!raced.rows[0]) conflict('thread pin conflict could not be resolved');
        return this.verifyExistingPin(pinFrom(raced.rows[0]), request);
      }
    });
  }

  async getThreadPin(tenantId: string, threadId: string): Promise<ThreadPin | null> {
    await this.ready;
    const result = await this.client.query(
      `SELECT * FROM ${this.table.pins} WHERE thread_id=$1`,
      [threadId],
    );
    if (!result.rows[0]) return null;
    const pin = pinFrom(result.rows[0]);
    if (pin.tenantId !== tenantId) accessDenied();
    return pin;
  }

  private verifyExistingPin(pin: ThreadPin, request: ThreadAssignmentRequest): ThreadPin {
    if (pin.tenantId !== request.tenantId) accessDenied();
    if (pin.agentEntityId !== request.agentEntityId || pin.environment !== request.environment) {
      conflict('thread is already pinned to a different agent or environment');
    }
    return pin;
  }

  private async transaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = this.client.connect ? await this.client.connect() : this.client;
    await client.query('BEGIN');
    try {
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release?.();
    }
  }

  async migrate(): Promise<void> {
    await this.transaction(async client => {
      for (const statement of postgresDeploymentMigrationStatements({
        tablePrefix: this.tablePrefix,
        schema: this.schema,
      })) {
        await client.query(statement);
      }
    });
  }
}
