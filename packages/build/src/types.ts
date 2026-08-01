import type { AgentArtifact, ToolReference } from '@kuralle-agents/deployment';

export type BuildTarget = 'node' | 'cloudflare';

export type BuildDiagnosticCode =
  | 'AGENT_CONFIG_INVALID'
  | 'CASE_COLLISION'
  | 'CREDENTIAL_DETECTED'
  | 'FILE_QUOTA_EXCEEDED'
  | 'INSTRUCTIONS_MISSING'
  | 'MODULE_EXPORT_INVALID'
  | 'PATH_INVALID'
  | 'SKILL_INVALID'
  | 'SYMLINK_REJECTED'
  | 'TARGET_INCOMPATIBLE'
  | 'UNKNOWN_SLOT';

export interface BuildDiagnostic {
  severity: 'error';
  code: BuildDiagnosticCode;
  path: string;
  message: string;
}

export interface BuildQuotas {
  maxDepth: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  inlineTextBytes: number;
}

export interface CompileAgentDirectoryOptions {
  defaultModel: string;
  compilerVersion: string;
  runtimeApiRange: string;
  target: BuildTarget;
  artifactIdPrefix?: string;
  capabilityVersion?: string;
  quotas?: Partial<BuildQuotas>;
}

export type ModuleKind = 'tool' | 'flow' | 'policy';

export interface CapabilityModule {
  kind: ModuleKind;
  id: string;
  capability: string;
  version: string;
  sourcePath: string;
  exportName: string;
  digest: string;
}

export interface ArtifactBlob {
  digest: string;
  sourcePath: string;
  bytes: number;
  mediaType: string;
}

export interface CompiledAgentProject {
  rootArtifact: AgentArtifact;
  artifacts: AgentArtifact[];
  modules: CapabilityModule[];
  blobs: ArtifactBlob[];
  diagnostics: BuildDiagnostic[];
}

export interface SerializableAgentFile {
  id?: string;
  name?: string;
  description?: string;
  model?: string;
  controlModel?: string;
  limits?: {
    maxTurns?: number;
    maxSteps?: number;
    toolMaxSteps?: number;
    maxOscillations?: number;
    maxToolConcurrency?: number;
  };
  handoffs?: string[];
}

export interface DiscoveredTool {
  reference: Extract<ToolReference, { kind: 'trusted' }>;
  module: CapabilityModule;
}

export const DEFAULT_BUILD_QUOTAS: BuildQuotas = {
  maxDepth: 3,
  maxFiles: 512,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 5_242_880,
  inlineTextBytes: 32_768,
};
