import { assertValidFlowDefinition } from './validate/index.js';
import { flowDigest } from './digest.js';
import type { FlowDefinition } from './types.js';

export const FLOW_DEFINITION_VERSION_STATUSES = ['active', 'superseded', 'archived'] as const;
export type FlowDefinitionVersionStatus = (typeof FLOW_DEFINITION_VERSION_STATUSES)[number];

export interface FlowDefinitionVersion {
  versionId: string;
  name: string;
  description: string;
  definition: FlowDefinition;
  digest: string;
  status: FlowDefinitionVersionStatus;
  authorId?: string;
  createdAt: Date;
  /** Model id used to compile natural-language `when` clauses. Server-set. */
  compilerModelId?: string;
  /** SHA-256 of the NL→predicate compiler system prompt. Server-set. */
  compilerPromptHash?: string;
  /** NL→predicate compiler version pin. Server-set. */
  compilerVersion?: string;
}

export interface CreateVersionOptions {
  authorId?: string;
  compilerModelId?: string;
  compilerPromptHash?: string;
  compilerVersion?: string;
}

export interface FlowDefinitionListFilter {
  status?: FlowDefinitionVersionStatus;
  authorId?: string;
  name?: string;
}

export class FlowDefinitionConflictError extends Error {
  readonly name = 'FlowDefinitionConflictError';
  readonly flowName: string;
  readonly digest: string;

  constructor(flowName: string, digest: string) {
    super(`Flow definition version already exists for "${flowName}" with digest ${digest}`);
    this.flowName = flowName;
    this.digest = digest;
  }
}

export class FlowDefinitionNotFoundError extends Error {
  readonly name = 'FlowDefinitionNotFoundError';
  readonly versionId?: string;
  readonly flowName?: string;

  constructor(key: { versionId?: string; name?: string }) {
    const label = key.versionId
      ? `version "${key.versionId}"`
      : key.name
        ? `name "${key.name}"`
        : 'the requested flow definition';
    super(`Flow definition ${label} was not found`);
    this.versionId = key.versionId;
    this.flowName = key.name;
  }
}

export class FlowDefinitionNameMismatchError extends Error {
  readonly name = 'FlowDefinitionNameMismatchError';
  readonly versionId: string;
  readonly expectedName: string;
  readonly actualName: string;

  constructor(versionId: string, expectedName: string, actualName: string) {
    super(`Version ${versionId} belongs to "${actualName}", not "${expectedName}"`);
    this.versionId = versionId;
    this.expectedName = expectedName;
    this.actualName = actualName;
  }
}

/**
 * Immutable versioned catalog of flow definitions.
 *
 * Publishing is two steps: `createVersion` inserts a row and does **not**
 * change the active pointer; `setActive(name, version.versionId)` is what
 * publishes. `status` and `digest` are server-computed — callers cannot
 * supply them. `authorId` is stored metadata, never an authorization check.
 */
export interface FlowDefinitionsStore {
  createVersion(def: FlowDefinition, options?: CreateVersionOptions): Promise<FlowDefinitionVersion>;
  setActive(name: string, versionId: string): Promise<FlowDefinitionVersion>;
  getActive(name: string): Promise<FlowDefinitionVersion | null>;
  getVersion(versionId: string): Promise<FlowDefinitionVersion | null>;
  list(filter?: FlowDefinitionListFilter): Promise<FlowDefinitionVersion[]>;
  archive(name: string): Promise<void>;
}

function compilerProvenance(
  row: Pick<FlowDefinitionVersion, 'compilerModelId' | 'compilerPromptHash' | 'compilerVersion'>,
): Pick<FlowDefinitionVersion, 'compilerModelId' | 'compilerPromptHash' | 'compilerVersion'> {
  return {
    ...(row.compilerModelId !== undefined ? { compilerModelId: row.compilerModelId } : {}),
    ...(row.compilerPromptHash !== undefined ? { compilerPromptHash: row.compilerPromptHash } : {}),
    ...(row.compilerVersion !== undefined ? { compilerVersion: row.compilerVersion } : {}),
  };
}

export function cloneFlowDefinitionVersion(row: FlowDefinitionVersion): FlowDefinitionVersion {
  return {
    versionId: row.versionId,
    name: row.name,
    description: row.description,
    definition: structuredClone(row.definition),
    digest: row.digest,
    status: row.status,
    ...(row.authorId !== undefined ? { authorId: row.authorId } : {}),
    createdAt: new Date(row.createdAt),
    ...compilerProvenance(row),
  };
}

export function reviveFlowDefinitionVersion(raw: {
  versionId: string;
  name: string;
  description: string;
  definition: FlowDefinition;
  digest: string;
  status: FlowDefinitionVersionStatus;
  authorId?: string | null;
  createdAt: Date | string;
  compilerModelId?: string | null;
  compilerPromptHash?: string | null;
  compilerVersion?: string | null;
}): FlowDefinitionVersion {
  return cloneFlowDefinitionVersion({
    versionId: raw.versionId,
    name: raw.name,
    description: raw.description,
    definition: raw.definition,
    digest: raw.digest,
    status: raw.status,
    ...(raw.authorId ? { authorId: raw.authorId } : {}),
    createdAt: new Date(raw.createdAt),
    ...(raw.compilerModelId ? { compilerModelId: raw.compilerModelId } : {}),
    ...(raw.compilerPromptHash ? { compilerPromptHash: raw.compilerPromptHash } : {}),
    ...(raw.compilerVersion ? { compilerVersion: raw.compilerVersion } : {}),
  });
}

export function isArchivedFlowName(rows: readonly FlowDefinitionVersion[], name: string): boolean {
  const ofName = rows.filter(row => row.name === name);
  return ofName.some(row => row.status === 'archived') && !ofName.some(row => row.status === 'active');
}

export function matchesFlowDefinitionListFilter(
  row: FlowDefinitionVersion,
  all: readonly FlowDefinitionVersion[],
  filter?: FlowDefinitionListFilter,
): boolean {
  if (filter?.name !== undefined && row.name !== filter.name) return false;
  if (filter?.authorId !== undefined && row.authorId !== filter.authorId) return false;
  if (filter?.status !== undefined) return row.status === filter.status;
  if (row.status === 'archived') return false;
  return !isArchivedFlowName(all, row.name);
}

export async function stampNewFlowDefinitionVersion(
  def: FlowDefinition,
  options?: CreateVersionOptions,
): Promise<FlowDefinitionVersion> {
  assertValidFlowDefinition(def);
  const digest = await flowDigest(def);
  return {
    versionId: crypto.randomUUID(),
    name: def.name,
    description: def.description,
    definition: structuredClone(def),
    digest,
    status: 'superseded',
    ...(options?.authorId !== undefined ? { authorId: options.authorId } : {}),
    createdAt: new Date(),
    ...compilerProvenance({
      compilerModelId: options?.compilerModelId,
      compilerPromptHash: options?.compilerPromptHash,
      compilerVersion: options?.compilerVersion,
    }),
  };
}
