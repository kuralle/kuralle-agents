import { satisfies, valid, validRange } from 'semver';
import { DeploymentError } from './errors.js';
import type {
  AgentArtifact,
  CapabilityRequirement,
  RuntimeCapability,
  RuntimeRevision,
} from './types.js';

export interface CompatibilityDiagnostic {
  code:
    | 'SCHEMA_UNSUPPORTED'
    | 'RUNTIME_API_INVALID'
    | 'RUNTIME_API_UNSUPPORTED'
    | 'CAPABILITY_RANGE_INVALID'
    | 'CAPABILITY_MISSING'
    | 'CAPABILITY_VERSION_UNSUPPORTED';
  message: string;
  capability?: string;
}

export interface CompatibilityReport {
  compatible: boolean;
  diagnostics: CompatibilityDiagnostic[];
}

function capabilityRequirements(artifact: AgentArtifact): CapabilityRequirement[] {
  const requirements = new Map<string, CapabilityRequirement>();
  for (const requirement of artifact.requiredCapabilities) {
    requirements.set(requirement.capability, requirement);
  }
  const references = [
    ...artifact.tools.filter(tool => tool.kind === 'trusted'),
    ...artifact.flows,
    ...Object.values(artifact.policies).filter(reference => reference !== undefined),
  ];
  for (const reference of references) {
    const current = requirements.get(reference.capability);
    if (current && current.versionRange !== reference.versionRange) {
      // Preserve both requirements. A runtime must satisfy both ranges.
      requirements.set(
        `${reference.capability}\u0000${reference.versionRange}`,
        { capability: reference.capability, versionRange: reference.versionRange },
      );
    } else if (!current || current.optional) {
      requirements.set(reference.capability, {
        capability: reference.capability,
        versionRange: reference.versionRange,
      });
    }
  }
  return [...requirements.values()];
}

function capabilityMap(capabilities: readonly RuntimeCapability[]): Map<string, RuntimeCapability> {
  return new Map(capabilities.map(capability => [capability.id, capability]));
}

export function preflightArtifact(
  artifact: AgentArtifact,
  runtime: RuntimeRevision,
): CompatibilityReport {
  const diagnostics: CompatibilityDiagnostic[] = [];
  if (!runtime.artifactSchemaVersions.includes(artifact.schemaVersion)) {
    diagnostics.push({
      code: 'SCHEMA_UNSUPPORTED',
      message: `runtime ${runtime.id} does not support artifact schema ${artifact.schemaVersion}`,
    });
  }

  if (!valid(runtime.runtimeApiVersion) || !validRange(artifact.runtimeApiRange)) {
    diagnostics.push({
      code: 'RUNTIME_API_INVALID',
      message: `invalid runtime API version/range: ${runtime.runtimeApiVersion} / ${artifact.runtimeApiRange}`,
    });
  } else if (!satisfies(runtime.runtimeApiVersion, artifact.runtimeApiRange)) {
    diagnostics.push({
      code: 'RUNTIME_API_UNSUPPORTED',
      message: `runtime API ${runtime.runtimeApiVersion} does not satisfy ${artifact.runtimeApiRange}`,
    });
  }

  const available = capabilityMap(runtime.capabilities);
  for (const requirement of capabilityRequirements(artifact)) {
    const capability = available.get(requirement.capability);
    if (!validRange(requirement.versionRange)) {
      diagnostics.push({
        code: 'CAPABILITY_RANGE_INVALID',
        capability: requirement.capability,
        message: `invalid version range ${requirement.versionRange}`,
      });
      continue;
    }
    if (!capability) {
      if (!requirement.optional) {
        diagnostics.push({
          code: 'CAPABILITY_MISSING',
          capability: requirement.capability,
          message: `runtime is missing ${requirement.capability}`,
        });
      }
      continue;
    }
    if (!valid(capability.version) || !satisfies(capability.version, requirement.versionRange)) {
      diagnostics.push({
        code: 'CAPABILITY_VERSION_UNSUPPORTED',
        capability: requirement.capability,
        message: `${capability.id}@${capability.version} does not satisfy ${requirement.versionRange}`,
      });
    }
  }

  return { compatible: diagnostics.length === 0, diagnostics };
}

export function assertArtifactCompatible(
  artifact: AgentArtifact,
  runtime: RuntimeRevision,
): void {
  const report = preflightArtifact(artifact, runtime);
  if (!report.compatible) {
    throw new DeploymentError(
      'RUNTIME_INCOMPATIBLE',
      report.diagnostics.map(diagnostic => diagnostic.message).join('; '),
    );
  }
}
