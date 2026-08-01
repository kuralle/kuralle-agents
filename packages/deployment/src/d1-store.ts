import { validateArtifact } from './artifact.js';
import { validateThreadAssignmentRequest } from './assignment.js';
import { canonicalJson } from './canonical.js';
import { DeploymentError } from './errors.js';
import { assertArtifactCompatible } from './preflight.js';
import { selectReleaseAllocation, type DeploymentStore } from './store.js';
import type {
  AgentDraft,
  AgentEntity,
  AgentRelease,
  AgentVersion,
  ArtifactInputV1,
  PublishDraftRequest,
  RuntimeRevision,
  ThreadAssignmentRequest,
  ThreadPin,
} from './types.js';
import { createArtifact } from './artifact.js';

export type D1Value = string | number | boolean | null | ArrayBuffer | Uint8Array;

export interface D1ResultLike<T = Record<string, unknown>> {
  results?: T[];
  meta?: { changes?: number };
  success?: boolean;
}

export interface D1StatementLike {
  bind(...values: D1Value[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1ResultLike[]>;
}

export interface D1DeploymentStoreOptions {
  database: D1DatabaseLike;
  tablePrefix?: string;
  autoMigrate?: boolean;
}

interface Tables {
  entities: string;
  drafts: string;
  versions: string;
  runtimes: string;
  releases: string;
  allocations: string;
  active: string;
  pins: string;
}

function tableNames(prefix = 'kuralle_deploy'): Tables {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(prefix)) throw new Error(`Invalid deployment table prefix: ${prefix}`);
  return {
    entities: `${prefix}_agent_entities`,
    drafts: `${prefix}_agent_drafts`,
    versions: `${prefix}_agent_versions`,
    runtimes: `${prefix}_runtime_revisions`,
    releases: `${prefix}_releases`,
    allocations: `${prefix}_release_allocations`,
    active: `${prefix}_active_releases`,
    pins: `${prefix}_thread_pins`,
  };
}

function conflict(message: string): never { throw new DeploymentError('CONFLICT', message); }
function notFound(message: string): never { throw new DeploymentError('NOT_FOUND', message); }
function accessDenied(): never {
  throw new DeploymentError('ACCESS_DENIED', 'resource is not accessible in this tenant');
}
function json(value: unknown): string { return canonicalJson(value); }
function parse<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}
function changes(result: D1ResultLike): number { return Number(result.meta?.changes ?? 0); }

function entityFrom(row: Record<string, unknown>): AgentEntity {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), slug: String(row.slug),
    status: row.status as AgentEntity['status'], ownerId: String(row.owner_id),
    visibility: row.visibility as AgentEntity['visibility'],
    activeVersionId: row.active_version_id ? String(row.active_version_id) : undefined,
    createdAt: String(row.created_at),
  };
}

function draftFrom(row: Record<string, unknown>): AgentDraft {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), agentEntityId: String(row.agent_entity_id),
    revision: Number(row.revision), definition: parse(row.definition), updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  };
}

function pinFrom(row: Record<string, unknown>): ThreadPin {
  return {
    tenantId: String(row.tenant_id), threadId: String(row.thread_id),
    agentEntityId: String(row.agent_entity_id), agentVersionId: String(row.agent_version_id),
    artifactDigest: String(row.artifact_digest), runtimeRevisionId: String(row.runtime_revision_id),
    releaseId: String(row.release_id), branch: row.branch ? String(row.branch) : undefined,
    environment: String(row.environment), configGeneration: Number(row.config_generation),
    secretGeneration: Number(row.secret_generation), assignedAt: String(row.assigned_at),
  };
}

/** Cloudflare D1 control plane with append-only revisions and create-or-read thread pins. */
export class D1DeploymentStore implements DeploymentStore {
  private readonly database: D1DatabaseLike;
  private readonly table: Tables;
  private readonly ready: Promise<void>;

  constructor(options: D1DeploymentStoreOptions) {
    this.database = options.database;
    this.table = tableNames(options.tablePrefix);
    this.ready = (options.autoMigrate ?? true) ? this.migrate() : Promise.resolve();
  }

  async createEntity(entity: AgentEntity): Promise<void> {
    await this.ready;
    const result = await this.run(
      `INSERT INTO ${this.table.entities}
       (tenant_id,id,slug,status,owner_id,visibility,active_version_id,created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      entity.tenantId, entity.id, entity.slug, entity.status, entity.ownerId,
      entity.visibility, entity.activeVersionId ?? null, entity.createdAt,
    );
    if (changes(result) !== 1) conflict('agent entity already exists');
  }

  async getEntity(tenantId: string, entityId: string): Promise<AgentEntity | null> {
    await this.ready;
    const row = await this.first(`SELECT * FROM ${this.table.entities} WHERE tenant_id=? AND id=?`, tenantId, entityId);
    return row ? entityFrom(row) : null;
  }

  async saveDraft(draft: AgentDraft, expectedRevision: number): Promise<AgentDraft> {
    await this.ready;
    if (!await this.getEntity(draft.tenantId, draft.agentEntityId)) notFound('agent entity does not exist');
    let result: D1ResultLike;
    if (expectedRevision === 0) {
      result = await this.run(
        `INSERT INTO ${this.table.drafts}
         (tenant_id,id,agent_entity_id,revision,definition,updated_by,updated_at)
         VALUES (?,?,?,1,?,?,?) ON CONFLICT DO NOTHING`,
        draft.tenantId, draft.id, draft.agentEntityId, json(draft.definition), draft.updatedBy, draft.updatedAt,
      );
    } else {
      result = await this.run(
        `UPDATE ${this.table.drafts} SET definition=?,updated_by=?,updated_at=?,revision=revision+1
         WHERE tenant_id=? AND id=? AND agent_entity_id=? AND revision=?`,
        json(draft.definition), draft.updatedBy, draft.updatedAt, draft.tenantId, draft.id,
        draft.agentEntityId, expectedRevision,
      );
    }
    if (changes(result) !== 1) {
      const current = await this.getDraft(draft.tenantId, draft.id);
      if (!current) conflict(`draft revision changed: expected ${expectedRevision}, received 0`);
      if (current.agentEntityId !== draft.agentEntityId) conflict('draft cannot move between agent entities');
      conflict(`draft revision changed: expected ${expectedRevision}, received ${current.revision}`);
    }
    return (await this.getDraft(draft.tenantId, draft.id))!;
  }

  async getDraft(tenantId: string, draftId: string): Promise<AgentDraft | null> {
    await this.ready;
    const row = await this.first(`SELECT * FROM ${this.table.drafts} WHERE tenant_id=? AND id=?`, tenantId, draftId);
    return row ? draftFrom(row) : null;
  }

  async publishDraft(request: PublishDraftRequest): Promise<AgentVersion> {
    const draft = await this.getDraft(request.tenantId, request.draftId);
    if (!draft) notFound('agent draft does not exist');
    if (draft.revision !== request.draftRevision) {
      conflict(`draft revision changed: expected ${request.draftRevision}, received ${draft.revision}`);
    }
    const version: AgentVersion = {
      id: request.versionId, tenantId: request.tenantId, agentEntityId: draft.agentEntityId,
      version: request.version, artifact: await createArtifact(draft.definition as ArtifactInputV1),
      createdBy: request.createdBy, createdAt: request.createdAt,
    };
    await this.createVersion(version);
    return version;
  }

  async createVersion(version: AgentVersion): Promise<void> {
    await this.ready;
    if (!await this.getEntity(version.tenantId, version.agentEntityId)) notFound('agent entity does not exist');
    const artifact = await validateArtifact(version.artifact);
    const result = await this.run(
      `INSERT INTO ${this.table.versions}
       (tenant_id,id,agent_entity_id,version,digest,artifact,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      version.tenantId, version.id, version.agentEntityId, version.version, artifact.digest,
      json(artifact), version.createdBy, version.createdAt,
    );
    if (changes(result) !== 1) conflict('agent version already exists');
  }

  async getVersion(tenantId: string, versionId: string): Promise<AgentVersion | null> {
    await this.ready;
    const row = await this.first(`SELECT * FROM ${this.table.versions} WHERE tenant_id=? AND id=?`, tenantId, versionId);
    if (!row) return null;
    return {
      id: String(row.id), tenantId: String(row.tenant_id), agentEntityId: String(row.agent_entity_id),
      version: Number(row.version), artifact: await validateArtifact(parse(row.artifact)),
      createdBy: String(row.created_by), createdAt: String(row.created_at),
    };
  }

  async registerRuntime(revision: RuntimeRevision): Promise<void> {
    await this.ready;
    if (!revision.artifactSchemaVersions.includes(1)) {
      throw new DeploymentError('RELEASE_INVALID', 'runtime must support artifact schema version 1');
    }
    if (new Set(revision.capabilities.map(item => item.id)).size !== revision.capabilities.length) {
      throw new DeploymentError('RELEASE_INVALID', 'runtime capability ids must be unique');
    }
    const result = await this.run(
      `INSERT INTO ${this.table.runtimes} (id,definition,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`,
      revision.id, json(revision), revision.createdAt,
    );
    if (changes(result) !== 1) conflict('runtime revision already exists');
  }

  async createRelease(release: AgentRelease): Promise<void> {
    await this.ready;
    if (!await this.getEntity(release.tenantId, release.agentEntityId)) notFound('agent entity does not exist');
    if (release.allocations.length === 0) {
      throw new DeploymentError('RELEASE_INVALID', 'release must contain at least one allocation');
    }
    const total = release.allocations.reduce((sum, item) => sum + item.weight, 0);
    if (total !== 10_000 || release.allocations.some(item => !Number.isSafeInteger(item.weight) || item.weight <= 0)) {
      throw new DeploymentError('RELEASE_INVALID', 'release weights must be positive integers totaling 10000');
    }
    for (const allocation of release.allocations) {
      const version = await this.getVersion(release.tenantId, allocation.agentVersionId);
      if (!version || version.agentEntityId !== release.agentEntityId) {
        throw new DeploymentError('RELEASE_INVALID', 'release references an inaccessible agent version');
      }
      const runtimeRow = await this.first(`SELECT definition FROM ${this.table.runtimes} WHERE id=?`, allocation.runtimeRevisionId);
      if (!runtimeRow) throw new DeploymentError('RELEASE_INVALID', 'release references an unknown runtime revision');
      try {
        assertArtifactCompatible(version.artifact, parse<RuntimeRevision>(runtimeRow.definition));
      } catch (error) {
        throw new DeploymentError('RELEASE_INVALID', error instanceof Error ? error.message : 'runtime is incompatible');
      }
    }
    if (await this.first(`SELECT id FROM ${this.table.releases} WHERE tenant_id=? AND id=?`, release.tenantId, release.id)) {
      conflict('release already exists');
    }
    const statements = [this.statement(
      `INSERT INTO ${this.table.releases}
       (tenant_id,id,agent_entity_id,environment,state,branch,created_at) VALUES (?,?,?,?,?,?,?)`,
      release.tenantId, release.id, release.agentEntityId, release.environment,
      release.state, release.branch ?? null, release.createdAt,
    )];
    release.allocations.forEach((allocation, ordinal) => statements.push(this.statement(
      `INSERT INTO ${this.table.allocations}
       (tenant_id,release_id,ordinal,agent_version_id,runtime_revision_id,weight) VALUES (?,?,?,?,?,?)`,
      release.tenantId, release.id, ordinal, allocation.agentVersionId,
      allocation.runtimeRevisionId, allocation.weight,
    )));
    await this.database.batch(statements);
  }

  async activateRelease(tenantId: string, releaseId: string): Promise<void> {
    await this.ready;
    const release = await this.first(`SELECT * FROM ${this.table.releases} WHERE tenant_id=? AND id=?`, tenantId, releaseId);
    if (!release) notFound('release does not exist');
    if (release.state !== 'active') {
      throw new DeploymentError('RELEASE_INVALID', 'only an active release can receive traffic');
    }
    await this.run(
      `INSERT INTO ${this.table.active}
       (tenant_id,agent_entity_id,environment,release_id,updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (tenant_id,agent_entity_id,environment)
       DO UPDATE SET release_id=excluded.release_id,updated_at=excluded.updated_at`,
      tenantId, String(release.agent_entity_id), String(release.environment), releaseId, new Date().toISOString(),
    );
  }

  async assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin> {
    await this.ready;
    validateThreadAssignmentRequest(request);
    const current = await this.rawThreadPin(request.threadId);
    if (current) return this.verifyPin(current, request);
    const release = await this.first(
      `SELECT r.* FROM ${this.table.active} a JOIN ${this.table.releases} r
       ON r.tenant_id=a.tenant_id AND r.id=a.release_id
       WHERE a.tenant_id=? AND a.agent_entity_id=? AND a.environment=?`,
      request.tenantId, request.agentEntityId, request.environment,
    );
    if (!release) notFound('no active release exists for this agent and environment');
    const allocationRows = await this.all(
      `SELECT agent_version_id,runtime_revision_id,weight FROM ${this.table.allocations}
       WHERE tenant_id=? AND release_id=? ORDER BY ordinal`,
      request.tenantId, String(release.id),
    );
    const allocations = allocationRows.map(row => ({
      agentVersionId: String(row.agent_version_id), runtimeRevisionId: String(row.runtime_revision_id),
      weight: Number(row.weight),
    }));
    const allocation = await selectReleaseAllocation(allocations, [
      request.tenantId, request.environment, request.agentEntityId, String(release.id), request.threadId,
    ]);
    const version = await this.first(
      `SELECT digest FROM ${this.table.versions} WHERE tenant_id=? AND id=?`,
      request.tenantId, allocation.agentVersionId,
    );
    if (!version) notFound('assigned agent version does not exist');
    const pin: ThreadPin = {
      tenantId: request.tenantId, threadId: request.threadId, agentEntityId: request.agentEntityId,
      agentVersionId: allocation.agentVersionId, artifactDigest: String(version.digest),
      runtimeRevisionId: allocation.runtimeRevisionId, releaseId: String(release.id),
      branch: release.branch ? String(release.branch) : undefined, environment: request.environment,
      configGeneration: request.configGeneration ?? 1, secretGeneration: request.secretGeneration ?? 1,
      assignedAt: request.assignedAt ?? new Date().toISOString(),
    };
    await this.run(
      `INSERT INTO ${this.table.pins}
       (thread_id,tenant_id,agent_entity_id,agent_version_id,artifact_digest,runtime_revision_id,
        release_id,branch,environment,config_generation,secret_generation,assigned_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO NOTHING`,
      pin.threadId, pin.tenantId, pin.agentEntityId, pin.agentVersionId, pin.artifactDigest,
      pin.runtimeRevisionId, pin.releaseId, pin.branch ?? null, pin.environment,
      pin.configGeneration, pin.secretGeneration, pin.assignedAt,
    );
    const assigned = await this.rawThreadPin(request.threadId);
    if (!assigned) conflict('thread pin conflict could not be resolved');
    return this.verifyPin(assigned, request);
  }

  async getThreadPin(tenantId: string, threadId: string): Promise<ThreadPin | null> {
    await this.ready;
    const pin = await this.rawThreadPin(threadId);
    if (!pin) return null;
    if (pin.tenantId !== tenantId) accessDenied();
    return pin;
  }

  private verifyPin(pin: ThreadPin, request: ThreadAssignmentRequest): ThreadPin {
    if (pin.tenantId !== request.tenantId) accessDenied();
    if (pin.agentEntityId !== request.agentEntityId || pin.environment !== request.environment) {
      conflict('thread is already pinned to a different agent or environment');
    }
    return pin;
  }

  private async rawThreadPin(threadId: string): Promise<ThreadPin | null> {
    const row = await this.first(`SELECT * FROM ${this.table.pins} WHERE thread_id=?`, threadId);
    return row ? pinFrom(row) : null;
  }

  private statement(sql: string, ...values: D1Value[]): D1StatementLike {
    return this.database.prepare(sql).bind(...values);
  }

  private run(sql: string, ...values: D1Value[]): Promise<D1ResultLike> {
    return this.statement(sql, ...values).run();
  }

  private async all(sql: string, ...values: D1Value[]): Promise<Record<string, unknown>[]> {
    const result = await this.statement(sql, ...values).all();
    return result.results ?? [];
  }

  private async first(sql: string, ...values: D1Value[]): Promise<Record<string, unknown> | null> {
    return (await this.all(sql, ...values))[0] ?? null;
  }

  private async migrate(): Promise<void> {
    const t = this.table;
    const sql = [
      `CREATE TABLE IF NOT EXISTS ${t.entities} (
       tenant_id TEXT NOT NULL,id TEXT NOT NULL,slug TEXT NOT NULL,status TEXT NOT NULL,
       owner_id TEXT NOT NULL,visibility TEXT NOT NULL,active_version_id TEXT,created_at TEXT NOT NULL,
       PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,slug))`,
      `CREATE TABLE IF NOT EXISTS ${t.drafts} (
       tenant_id TEXT NOT NULL,id TEXT NOT NULL,agent_entity_id TEXT NOT NULL,revision INTEGER NOT NULL,
       definition TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id))`,
      `CREATE TABLE IF NOT EXISTS ${t.versions} (
       tenant_id TEXT NOT NULL,id TEXT NOT NULL,agent_entity_id TEXT NOT NULL,version INTEGER NOT NULL,
       digest TEXT NOT NULL,artifact TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,
       PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,agent_entity_id,version))`,
      `CREATE TABLE IF NOT EXISTS ${t.runtimes} (
       id TEXT PRIMARY KEY,definition TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${t.releases} (
       tenant_id TEXT NOT NULL,id TEXT NOT NULL,agent_entity_id TEXT NOT NULL,environment TEXT NOT NULL,
       state TEXT NOT NULL,branch TEXT,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id))`,
      `CREATE TABLE IF NOT EXISTS ${t.allocations} (
       tenant_id TEXT NOT NULL,release_id TEXT NOT NULL,ordinal INTEGER NOT NULL,agent_version_id TEXT NOT NULL,
       runtime_revision_id TEXT NOT NULL,weight INTEGER NOT NULL,PRIMARY KEY(tenant_id,release_id,ordinal))`,
      `CREATE TABLE IF NOT EXISTS ${t.active} (
       tenant_id TEXT NOT NULL,agent_entity_id TEXT NOT NULL,environment TEXT NOT NULL,release_id TEXT NOT NULL,
       updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,agent_entity_id,environment))`,
      `CREATE TABLE IF NOT EXISTS ${t.pins} (
       thread_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,agent_entity_id TEXT NOT NULL,agent_version_id TEXT NOT NULL,
       artifact_digest TEXT NOT NULL,runtime_revision_id TEXT NOT NULL,release_id TEXT NOT NULL,branch TEXT,
       environment TEXT NOT NULL,config_generation INTEGER NOT NULL,secret_generation INTEGER NOT NULL,
       assigned_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${t.pins}_tenant_agent_idx
       ON ${t.pins}(tenant_id,agent_entity_id,environment)`,
    ];
    await this.database.batch(sql.map(statement => this.database.prepare(statement)));
  }
}
