import { canonicalJson, sha256 } from './canonical.js';
import { createArtifact, validateArtifact } from './artifact.js';
import { DeploymentError } from './errors.js';
import { assertArtifactCompatible } from './preflight.js';
import { validateThreadAssignmentRequest } from './assignment.js';
import type {
  AgentEntity,
  AgentDraft,
  AgentRelease,
  AgentVersion,
  ArtifactInputV1,
  ReleaseAllocation,
  RuntimeRevision,
  PublishDraftRequest,
  ThreadAssignmentRequest,
  ThreadPin,
} from './types.js';

export interface DeploymentStore {
  createEntity(entity: AgentEntity): Promise<void>;
  getEntity(tenantId: string, entityId: string): Promise<AgentEntity | null>;
  saveDraft(draft: AgentDraft, expectedRevision: number): Promise<AgentDraft>;
  getDraft(tenantId: string, draftId: string): Promise<AgentDraft | null>;
  publishDraft(request: PublishDraftRequest): Promise<AgentVersion>;
  createVersion(version: AgentVersion): Promise<void>;
  getVersion(tenantId: string, versionId: string): Promise<AgentVersion | null>;
  registerRuntime(revision: RuntimeRevision): Promise<void>;
  createRelease(release: AgentRelease): Promise<void>;
  activateRelease(tenantId: string, releaseId: string): Promise<void>;
  assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin>;
  getThreadPin(tenantId: string, threadId: string): Promise<ThreadPin | null>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(...parts: string[]): string {
  return parts.map(part => `${part.length}:${part}`).join('|');
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

function validateIdentity(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new DeploymentError('RELEASE_INVALID', `${name} has an invalid identifier format`);
  }
}

export async function selectReleaseAllocation(
  allocations: readonly ReleaseAllocation[],
  assignmentKey: readonly string[],
): Promise<ReleaseAllocation> {
  const digest = await sha256(canonicalJson(assignmentKey));
  const bucket = Number.parseInt(digest.slice(0, 12), 16) % 10_000;
  let boundary = 0;
  for (const allocation of allocations) {
    boundary += allocation.weight;
    if (bucket < boundary) return allocation;
  }
  throw new DeploymentError('RELEASE_INVALID', 'release allocation weights do not cover the assignment space');
}

/**
 * Reference control-plane implementation for tests, local development, and adapter conformance.
 * Production adapters must provide equivalent uniqueness and atomic create-or-read semantics.
 */
export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly entities = new Map<string, AgentEntity>();
  private readonly drafts = new Map<string, AgentDraft>();
  private readonly versions = new Map<string, AgentVersion>();
  private readonly runtimes = new Map<string, RuntimeRevision>();
  private readonly releases = new Map<string, AgentRelease>();
  private readonly activeReleases = new Map<string, string>();
  private readonly pins = new Map<string, ThreadPin>();

  async createEntity(entity: AgentEntity): Promise<void> {
    validateIdentity(entity.id, 'entity id');
    validateIdentity(entity.tenantId, 'tenant id');
    const entityKey = key(entity.tenantId, entity.id);
    if (this.entities.has(entityKey)) conflict('agent entity already exists');
    this.entities.set(entityKey, clone(entity));
  }

  async getEntity(tenantId: string, entityId: string): Promise<AgentEntity | null> {
    const entity = this.entities.get(key(tenantId, entityId));
    return entity ? clone(entity) : null;
  }

  async saveDraft(draft: AgentDraft, expectedRevision: number): Promise<AgentDraft> {
    const entity = this.entities.get(key(draft.tenantId, draft.agentEntityId));
    if (!entity) notFound('agent entity does not exist');
    const draftKey = key(draft.tenantId, draft.id);
    const current = this.drafts.get(draftKey);
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      conflict(`draft revision changed: expected ${expectedRevision}, received ${actualRevision}`);
    }
    if (current && current.agentEntityId !== draft.agentEntityId) {
      conflict('draft cannot move between agent entities');
    }
    // Canonical JSON is also the JSON-safety gate: closures, symbols, bigint,
    // and non-finite numbers cannot be smuggled into builder state.
    const definition = JSON.parse(canonicalJson(draft.definition)) as AgentDraft['definition'];
    const saved = clone({ ...draft, definition, revision: actualRevision + 1 });
    this.drafts.set(draftKey, saved);
    return clone(saved);
  }

  async getDraft(tenantId: string, draftId: string): Promise<AgentDraft | null> {
    const draft = this.drafts.get(key(tenantId, draftId));
    return draft ? clone(draft) : null;
  }

  async publishDraft(request: PublishDraftRequest): Promise<AgentVersion> {
    const draft = this.drafts.get(key(request.tenantId, request.draftId));
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
    return clone(version);
  }

  async createVersion(version: AgentVersion): Promise<void> {
    const entity = this.entities.get(key(version.tenantId, version.agentEntityId));
    if (!entity) notFound('agent entity does not exist');
    const assertAvailable = (): string => {
      const versionKey = key(version.tenantId, version.id);
      if (this.versions.has(versionKey)) conflict('agent version already exists');
      for (const existing of this.versions.values()) {
        if (
          existing.tenantId === version.tenantId &&
          existing.agentEntityId === version.agentEntityId &&
          existing.version === version.version
        ) {
          conflict('agent version number already exists');
        }
      }
      return versionKey;
    };
    assertAvailable();
    const artifact = await validateArtifact(version.artifact);
    // Artifact verification yields to Web Crypto. Re-check after it resolves so
    // concurrent publications retain the same write-once semantics as a unique
    // database constraint.
    this.versions.set(assertAvailable(), clone({ ...version, artifact }));
  }

  async getVersion(tenantId: string, versionId: string): Promise<AgentVersion | null> {
    const version = this.versions.get(key(tenantId, versionId));
    return version ? clone(version) : null;
  }

  async registerRuntime(revision: RuntimeRevision): Promise<void> {
    validateIdentity(revision.id, 'runtime revision id');
    if (this.runtimes.has(revision.id)) conflict('runtime revision already exists');
    if (!revision.artifactSchemaVersions.includes(1)) {
      throw new DeploymentError('RELEASE_INVALID', 'runtime must support artifact schema version 1');
    }
    const capabilityIds = revision.capabilities.map(capability => capability.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      throw new DeploymentError('RELEASE_INVALID', 'runtime capability ids must be unique');
    }
    this.runtimes.set(revision.id, clone(revision));
  }

  async createRelease(release: AgentRelease): Promise<void> {
    const entity = this.entities.get(key(release.tenantId, release.agentEntityId));
    if (!entity) notFound('agent entity does not exist');
    const releaseKey = key(release.tenantId, release.id);
    if (this.releases.has(releaseKey)) conflict('release already exists');
    if (release.allocations.length === 0) {
      throw new DeploymentError('RELEASE_INVALID', 'release must contain at least one allocation');
    }
    const total = release.allocations.reduce((sum, allocation) => sum + allocation.weight, 0);
    if (
      total !== 10_000 ||
      release.allocations.some(allocation => !Number.isSafeInteger(allocation.weight) || allocation.weight <= 0)
    ) {
      throw new DeploymentError('RELEASE_INVALID', 'release weights must be positive integers totaling 10000');
    }
    for (const allocation of release.allocations) {
      const version = this.versions.get(key(release.tenantId, allocation.agentVersionId));
      if (!version || version.agentEntityId !== release.agentEntityId) {
        throw new DeploymentError('RELEASE_INVALID', 'release references an inaccessible agent version');
      }
      const runtime = this.runtimes.get(allocation.runtimeRevisionId);
      if (!runtime) throw new DeploymentError('RELEASE_INVALID', 'release references an unknown runtime revision');
      try {
        assertArtifactCompatible(version.artifact, runtime);
      } catch (error) {
        throw new DeploymentError(
          'RELEASE_INVALID',
          error instanceof Error ? error.message : 'runtime is incompatible with the artifact',
        );
      }
    }
    this.releases.set(releaseKey, clone(release));
  }

  async activateRelease(tenantId: string, releaseId: string): Promise<void> {
    const release = this.releases.get(key(tenantId, releaseId));
    if (!release) notFound('release does not exist');
    if (release.state !== 'active') {
      throw new DeploymentError('RELEASE_INVALID', 'only an active release can receive traffic');
    }
    this.activeReleases.set(
      key(tenantId, release.agentEntityId, release.environment),
      release.id,
    );
  }

  async assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin> {
    validateThreadAssignmentRequest(request);
    const existingBeforeResolution = this.pins.get(request.threadId);
    if (existingBeforeResolution) {
      if (existingBeforeResolution.tenantId !== request.tenantId) accessDenied();
      if (
        existingBeforeResolution.agentEntityId !== request.agentEntityId ||
        existingBeforeResolution.environment !== request.environment
      ) {
        conflict('thread is already pinned to a different agent or environment');
      }
      return clone(existingBeforeResolution);
    }

    const activeReleaseId = this.activeReleases.get(
      key(request.tenantId, request.agentEntityId, request.environment),
    );
    if (!activeReleaseId) notFound('no active release exists for this agent and environment');
    const release = this.releases.get(key(request.tenantId, activeReleaseId));
    if (!release) notFound('active release does not exist');
    const allocation = await selectReleaseAllocation(release.allocations, [
      request.tenantId,
      request.environment,
      request.agentEntityId,
      release.id,
      request.threadId,
    ]);
    const version = this.versions.get(key(request.tenantId, allocation.agentVersionId));
    if (!version) notFound('assigned agent version does not exist');

    const pin: ThreadPin = {
      tenantId: request.tenantId,
      threadId: request.threadId,
      agentEntityId: request.agentEntityId,
      agentVersionId: version.id,
      artifactDigest: version.artifact.digest,
      runtimeRevisionId: allocation.runtimeRevisionId,
      releaseId: release.id,
      branch: release.branch,
      environment: request.environment,
      configGeneration: request.configGeneration ?? 1,
      secretGeneration: request.secretGeneration ?? 1,
      assignedAt: request.assignedAt ?? new Date().toISOString(),
    };

    // Web Crypto yields while selecting. Re-check so concurrent first turns have
    // create-or-read semantics. A database adapter implements this with a unique
    // thread key and transaction/compare-and-swap.
    const existingAfterResolution = this.pins.get(request.threadId);
    if (existingAfterResolution) {
      if (existingAfterResolution.tenantId !== request.tenantId) accessDenied();
      return clone(existingAfterResolution);
    }
    this.pins.set(request.threadId, clone(pin));
    return clone(pin);
  }

  async getThreadPin(tenantId: string, threadId: string): Promise<ThreadPin | null> {
    const pin = this.pins.get(threadId);
    if (!pin) return null;
    if (pin.tenantId !== tenantId) accessDenied();
    return clone(pin);
  }
}
