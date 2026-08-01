export type ArtifactSchemaVersion = 1;

export interface CompilerIdentity {
  name: 'kuralle';
  version: string;
}

export type ContentRole = 'instructions' | 'skill' | 'reference' | 'workspace-seed';

export interface InlineContent {
  kind: 'inline';
  text: string;
}

export interface BlobContent {
  kind: 'blob';
  ref: string;
}

export interface ContentEntry {
  path: string;
  digest: string;
  bytes: number;
  mediaType: string;
  role: ContentRole;
  content: InlineContent | BlobContent;
}

export interface SkillArtifact {
  name: string;
  description: string;
  digest: string;
  entrypoint: string;
  files: ContentEntry[];
}

export interface CapabilityReference {
  id: string;
  capability: string;
  versionRange: string;
}

export interface TrustedToolReference extends CapabilityReference {
  kind: 'trusted';
}

export interface HttpToolReference {
  kind: 'http';
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  authSecretRef?: string;
}

export interface McpToolReference {
  kind: 'mcp';
  id: string;
  server: string;
  tool: string;
  authSecretRef?: string;
}

export interface BuiltinToolReference {
  kind: 'builtin';
  id: string;
  name: string;
}

export interface ClientToolReference {
  kind: 'client';
  id: string;
  name: string;
}

export type ToolReference =
  | TrustedToolReference
  | HttpToolReference
  | McpToolReference
  | BuiltinToolReference
  | ClientToolReference;

export interface PolicyArtifact {
  input?: CapabilityReference;
  output?: CapabilityReference;
  tool?: CapabilityReference;
  refine?: CapabilityReference;
  validate?: CapabilityReference;
}

export interface CapabilityRequirement {
  capability: string;
  versionRange: string;
  optional?: boolean;
}

export interface SecretReference {
  alias: string;
  purpose: string;
}

export interface SourceMapEntry {
  source: string;
  target: string;
  digest: string;
}

export interface AgentNode {
  id: string;
  artifactId: string;
  digest: string;
}

export interface AgentArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  digest: string;
  compiler: CompilerIdentity;
  runtimeApiRange: string;
  agent: {
    id: string;
    name?: string;
    description?: string;
    model: string;
    controlModel?: string;
    limits?: SerializableLimits;
    handoffs?: string[];
  };
  instructions: ContentEntry[];
  skills: SkillArtifact[];
  references: ContentEntry[];
  workspaceSeed: ContentEntry[];
  agents: AgentNode[];
  tools: ToolReference[];
  flows: CapabilityReference[];
  policies: PolicyArtifact;
  requiredCapabilities: CapabilityRequirement[];
  secretRefs: SecretReference[];
  sourceMap: SourceMapEntry[];
}

export interface SerializableLimits {
  maxTurns?: number;
  maxSteps?: number;
  toolMaxSteps?: number;
  maxOscillations?: number;
  maxToolConcurrency?: number;
}

export type AgentArtifact = AgentArtifactV1;
export type ArtifactInputV1 = Omit<AgentArtifactV1, 'digest'> & { digest?: string };

export interface AgentEntity {
  id: string;
  tenantId: string;
  slug: string;
  status: 'draft' | 'active' | 'archived';
  ownerId: string;
  visibility: 'private' | 'tenant';
  activeVersionId?: string;
  createdAt: string;
}

export interface AgentVersion {
  id: string;
  tenantId: string;
  agentEntityId: string;
  version: number;
  artifact: AgentArtifact;
  createdBy: string;
  createdAt: string;
}

/** Mutable builder state. It is never resolved by production execution. */
export interface AgentDraft {
  id: string;
  tenantId: string;
  agentEntityId: string;
  revision: number;
  definition: Partial<ArtifactInputV1>;
  updatedBy: string;
  updatedAt: string;
}

export interface PublishDraftRequest {
  tenantId: string;
  draftId: string;
  draftRevision: number;
  versionId: string;
  version: number;
  createdBy: string;
  createdAt: string;
}

export interface RuntimeCapability {
  id: string;
  version: string;
}

export interface RuntimeRevision {
  id: string;
  artifactSchemaVersions: ArtifactSchemaVersion[];
  runtimeApiVersion: string;
  capabilities: RuntimeCapability[];
  createdAt: string;
}

export interface ReleaseAllocation {
  agentVersionId: string;
  runtimeRevisionId: string;
  weight: number;
}

export interface AgentRelease {
  id: string;
  tenantId: string;
  agentEntityId: string;
  environment: string;
  state: 'draft' | 'active' | 'retired';
  branch?: string;
  allocations: ReleaseAllocation[];
  createdAt: string;
}

export interface ThreadPin {
  tenantId: string;
  threadId: string;
  agentEntityId: string;
  agentVersionId: string;
  artifactDigest: string;
  runtimeRevisionId: string;
  releaseId: string;
  branch?: string;
  environment: string;
  configGeneration: number;
  secretGeneration: number;
  assignedAt: string;
}

export interface ThreadAssignmentRequest {
  tenantId: string;
  threadId: string;
  agentEntityId: string;
  environment: string;
  configGeneration?: number;
  secretGeneration?: number;
  assignedAt?: string;
}
