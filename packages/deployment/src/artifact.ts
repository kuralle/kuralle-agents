import { canonicalJson, sha256 } from './canonical.js';
import { DeploymentError } from './errors.js';
import type {
  AgentArtifact,
  ArtifactInputV1,
  CapabilityReference,
  ContentEntry,
  PolicyArtifact,
  SkillArtifact,
  ToolReference,
} from './types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ALLOWED_CONTENT_ROLES = new Set(['instructions', 'skill', 'reference', 'workspace-seed']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function fail(message: string, path: string): never {
  throw new DeploymentError('ARTIFACT_INVALID', message, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('must be an object', path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail(`unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail('is required', `${path}.${key}`);
  }
}

function string(value: unknown, path: string, options: { id?: boolean; digest?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length === 0) return fail('must be a non-empty string', path);
  if (options.id && !ID_PATTERN.test(value)) return fail('has an invalid identifier format', path);
  if (options.digest && !SHA256_PATTERN.test(value)) return fail('must be a lowercase SHA-256 digest', path);
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) string(value, path);
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return fail('must be an array', path);
  return value;
}

function stringArray(value: unknown, path: string): void {
  array(value, path).forEach((entry, index) => string(entry, `${path}[${index}]`));
}

function nonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('must be a non-negative safe integer', path);
  }
}

function normalizedPath(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (
    candidate.startsWith('/') ||
    candidate.includes('\\') ||
    candidate.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    fail('must be a normalized relative path', path);
  }
  return candidate;
}

function contentEntry(value: unknown, path: string, expectedRole?: string): ContentEntry {
  const entry = record(value, path);
  exactKeys(entry, ['path', 'digest', 'bytes', 'mediaType', 'role', 'content'], [], path);
  normalizedPath(entry.path, `${path}.path`);
  string(entry.digest, `${path}.digest`, { digest: true });
  nonNegativeInteger(entry.bytes, `${path}.bytes`);
  string(entry.mediaType, `${path}.mediaType`);
  const role = string(entry.role, `${path}.role`);
  if (!ALLOWED_CONTENT_ROLES.has(role)) fail('has an unsupported content role', `${path}.role`);
  if (expectedRole && role !== expectedRole) fail(`must have role ${expectedRole}`, `${path}.role`);

  const content = record(entry.content, `${path}.content`);
  const kind = string(content.kind, `${path}.content.kind`);
  if (kind === 'inline') {
    exactKeys(content, ['kind', 'text'], [], `${path}.content`);
    if (typeof content.text !== 'string') fail('must be a string', `${path}.content.text`);
    const size = new TextEncoder().encode(content.text).byteLength;
    if (size !== entry.bytes) fail('does not match UTF-8 inline content length', `${path}.bytes`);
  } else if (kind === 'blob') {
    exactKeys(content, ['kind', 'ref'], [], `${path}.content`);
    string(content.ref, `${path}.content.ref`);
  } else {
    fail('must be inline or blob', `${path}.content.kind`);
  }
  return value as ContentEntry;
}

function capabilityReference(value: unknown, path: string): CapabilityReference {
  const ref = record(value, path);
  exactKeys(ref, ['id', 'capability', 'versionRange'], [], path);
  string(ref.id, `${path}.id`, { id: true });
  string(ref.capability, `${path}.capability`, { id: true });
  string(ref.versionRange, `${path}.versionRange`);
  return value as CapabilityReference;
}

function toolReference(value: unknown, path: string): ToolReference {
  const tool = record(value, path);
  const kind = string(tool.kind, `${path}.kind`);
  if (kind === 'trusted') {
    exactKeys(tool, ['kind', 'id', 'capability', 'versionRange'], [], path);
    string(tool.id, `${path}.id`, { id: true });
    string(tool.capability, `${path}.capability`, { id: true });
    string(tool.versionRange, `${path}.versionRange`);
  } else if (kind === 'http') {
    exactKeys(tool, ['kind', 'id', 'method', 'url'], ['authSecretRef'], path);
    string(tool.id, `${path}.id`, { id: true });
    const method = string(tool.method, `${path}.method`);
    if (!ALLOWED_METHODS.has(method)) fail('has an unsupported HTTP method', `${path}.method`);
    const urlText = string(tool.url, `${path}.url`);
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      return fail('must be an absolute URL', `${path}.url`);
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      fail('must use HTTPS and must not contain credentials', `${path}.url`);
    }
    optionalString(tool.authSecretRef, `${path}.authSecretRef`);
  } else if (kind === 'mcp') {
    exactKeys(tool, ['kind', 'id', 'server', 'tool'], ['authSecretRef'], path);
    string(tool.id, `${path}.id`, { id: true });
    string(tool.server, `${path}.server`);
    string(tool.tool, `${path}.tool`);
    optionalString(tool.authSecretRef, `${path}.authSecretRef`);
  } else if (kind === 'builtin' || kind === 'client') {
    exactKeys(tool, ['kind', 'id', 'name'], [], path);
    string(tool.id, `${path}.id`, { id: true });
    string(tool.name, `${path}.name`, { id: true });
  } else {
    fail('has an unsupported tool kind', `${path}.kind`);
  }
  return value as ToolReference;
}

function policies(value: unknown, path: string): PolicyArtifact {
  const policy = record(value, path);
  exactKeys(policy, [], ['input', 'output', 'tool', 'refine', 'validate'], path);
  for (const key of ['input', 'output', 'tool', 'refine', 'validate'] as const) {
    if (policy[key] !== undefined) capabilityReference(policy[key], `${path}.${key}`);
  }
  return value as PolicyArtifact;
}

function unique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`contains duplicate ${JSON.stringify(value)}`, path);
    seen.add(value);
  }
}

function validateStructure(value: unknown, requireDigest: boolean): AgentArtifact {
  const artifact = record(value, 'artifact');
  exactKeys(
    artifact,
    [
      'schemaVersion', 'artifactId', 'compiler', 'runtimeApiRange', 'agent', 'instructions',
      'skills', 'references', 'workspaceSeed', 'agents', 'tools', 'flows', 'policies',
      'requiredCapabilities', 'secretRefs', 'sourceMap',
    ],
    requireDigest ? ['digest'] : ['digest'],
    'artifact',
  );
  if (artifact.schemaVersion !== 1) fail('must equal 1', 'artifact.schemaVersion');
  string(artifact.artifactId, 'artifact.artifactId', { id: true });
  if (requireDigest) string(artifact.digest, 'artifact.digest', { digest: true });
  else if (artifact.digest !== undefined) string(artifact.digest, 'artifact.digest', { digest: true });

  const compiler = record(artifact.compiler, 'artifact.compiler');
  exactKeys(compiler, ['name', 'version'], [], 'artifact.compiler');
  if (compiler.name !== 'kuralle') fail('must equal kuralle', 'artifact.compiler.name');
  string(compiler.version, 'artifact.compiler.version');
  string(artifact.runtimeApiRange, 'artifact.runtimeApiRange');

  const agent = record(artifact.agent, 'artifact.agent');
  exactKeys(
    agent,
    ['id', 'model'],
    ['name', 'description', 'controlModel', 'limits', 'handoffs'],
    'artifact.agent',
  );
  string(agent.id, 'artifact.agent.id', { id: true });
  string(agent.model, 'artifact.agent.model');
  optionalString(agent.name, 'artifact.agent.name');
  optionalString(agent.description, 'artifact.agent.description');
  optionalString(agent.controlModel, 'artifact.agent.controlModel');
  if (agent.limits !== undefined) {
    const limits = record(agent.limits, 'artifact.agent.limits');
    exactKeys(
      limits,
      [],
      ['maxTurns', 'maxSteps', 'toolMaxSteps', 'maxOscillations', 'maxToolConcurrency'],
      'artifact.agent.limits',
    );
    for (const [key, limit] of Object.entries(limits)) {
      string(key, 'artifact.agent.limits key', { id: true });
      nonNegativeInteger(limit, `artifact.agent.limits.${key}`);
    }
  }
  if (agent.handoffs !== undefined) stringArray(agent.handoffs, 'artifact.agent.handoffs');

  const instructionEntries = array(artifact.instructions, 'artifact.instructions');
  const instructionPaths = instructionEntries.map((entry, index) =>
    contentEntry(entry, `artifact.instructions[${index}]`, 'instructions').path);
  if (instructionEntries.length === 0) fail('must contain at least one entry', 'artifact.instructions');
  unique(instructionPaths, 'artifact.instructions');

  const skillEntries = array(artifact.skills, 'artifact.skills');
  const skillNames: string[] = [];
  skillEntries.forEach((value, index) => {
    const path = `artifact.skills[${index}]`;
    const skill = record(value, path);
    exactKeys(skill, ['name', 'description', 'digest', 'entrypoint', 'files'], [], path);
    skillNames.push(string(skill.name, `${path}.name`, { id: true }));
    string(skill.description, `${path}.description`);
    string(skill.digest, `${path}.digest`, { digest: true });
    const entrypoint = normalizedPath(skill.entrypoint, `${path}.entrypoint`);
    const files = array(skill.files, `${path}.files`);
    const paths = files.map((entry, fileIndex) =>
      contentEntry(entry, `${path}.files[${fileIndex}]`, 'skill').path);
    unique(paths, `${path}.files`);
    if (!paths.includes(entrypoint)) fail('must name one packaged file', `${path}.entrypoint`);
  });
  unique(skillNames, 'artifact.skills');

  for (const [key, role] of [['references', 'reference'], ['workspaceSeed', 'workspace-seed']] as const) {
    const entries = array(artifact[key], `artifact.${key}`);
    const paths = entries.map((entry, index) => contentEntry(entry, `artifact.${key}[${index}]`, role).path);
    unique(paths, `artifact.${key}`);
  }

  const nodes = array(artifact.agents, 'artifact.agents');
  const nodeIds = nodes.map((value, index) => {
    const path = `artifact.agents[${index}]`;
    const node = record(value, path);
    exactKeys(node, ['id', 'artifactId', 'digest'], [], path);
    string(node.artifactId, `${path}.artifactId`, { id: true });
    string(node.digest, `${path}.digest`, { digest: true });
    return string(node.id, `${path}.id`, { id: true });
  });
  unique(nodeIds, 'artifact.agents');

  const toolEntries = array(artifact.tools, 'artifact.tools');
  const toolIds = toolEntries.map((tool, index) => toolReference(tool, `artifact.tools[${index}]`).id);
  unique(toolIds, 'artifact.tools');

  const flowEntries = array(artifact.flows, 'artifact.flows');
  const flowIds = flowEntries.map((flow, index) => capabilityReference(flow, `artifact.flows[${index}]`).id);
  unique(flowIds, 'artifact.flows');
  policies(artifact.policies, 'artifact.policies');

  const requirements = array(artifact.requiredCapabilities, 'artifact.requiredCapabilities');
  const requirementIds = requirements.map((value, index) => {
    const path = `artifact.requiredCapabilities[${index}]`;
    const requirement = record(value, path);
    exactKeys(requirement, ['capability', 'versionRange'], ['optional'], path);
    const id = string(requirement.capability, `${path}.capability`, { id: true });
    string(requirement.versionRange, `${path}.versionRange`);
    if (requirement.optional !== undefined && typeof requirement.optional !== 'boolean') {
      fail('must be a boolean', `${path}.optional`);
    }
    return id;
  });
  unique(requirementIds, 'artifact.requiredCapabilities');

  const secrets = array(artifact.secretRefs, 'artifact.secretRefs');
  const aliases = secrets.map((value, index) => {
    const path = `artifact.secretRefs[${index}]`;
    const secret = record(value, path);
    exactKeys(secret, ['alias', 'purpose'], [], path);
    string(secret.purpose, `${path}.purpose`);
    return string(secret.alias, `${path}.alias`, { id: true });
  });
  unique(aliases, 'artifact.secretRefs');
  const declaredSecrets = new Set(aliases);
  toolEntries.forEach((value, index) => {
    const tool = value as ToolReference;
    if (
      (tool.kind === 'http' || tool.kind === 'mcp') &&
      tool.authSecretRef &&
      !declaredSecrets.has(tool.authSecretRef)
    ) {
      fail('must reference a declared secret alias', `artifact.tools[${index}].authSecretRef`);
    }
  });

  const mappings = array(artifact.sourceMap, 'artifact.sourceMap');
  mappings.forEach((value, index) => {
    const path = `artifact.sourceMap[${index}]`;
    const mapping = record(value, path);
    exactKeys(mapping, ['source', 'target', 'digest'], [], path);
    normalizedPath(mapping.source, `${path}.source`);
    normalizedPath(mapping.target, `${path}.target`);
    string(mapping.digest, `${path}.digest`, { digest: true });
  });
  return value as AgentArtifact;
}

function withoutDigest(artifact: ArtifactInputV1 | AgentArtifact): Record<string, unknown> {
  const { digest: _digest, ...content } = artifact;
  return content;
}

async function validateInlineDigests(artifact: AgentArtifact): Promise<void> {
  const entries = [
    ...artifact.instructions,
    ...artifact.references,
    ...artifact.workspaceSeed,
    ...artifact.skills.flatMap(skill => skill.files),
  ];
  for (const entry of entries) {
    if (entry.content.kind !== 'inline') continue;
    const expected = await sha256(entry.content.text);
    if (entry.digest !== expected) {
      throw new DeploymentError(
        'ARTIFACT_DIGEST_MISMATCH',
        `content digest for ${entry.path} does not match its inline bytes`,
        entry.path,
      );
    }
  }
  for (const skill of artifact.skills) {
    const expected = await skillPackageDigest(skill);
    if (skill.digest !== expected) {
      throw new DeploymentError(
        'ARTIFACT_DIGEST_MISMATCH',
        `skill package digest for ${skill.name} does not match its packaged files`,
        `skills.${skill.name}`,
      );
    }
  }
}

/** Digest logical package content without coupling identity to inline/blob storage placement. */
export async function skillPackageDigest(skill: Omit<SkillArtifact, 'digest'> | SkillArtifact): Promise<string> {
  return sha256(canonicalJson({
    name: skill.name,
    description: skill.description,
    entrypoint: skill.entrypoint,
    files: skill.files.map(entry => ({
      path: entry.path,
      digest: entry.digest,
      bytes: entry.bytes,
      mediaType: entry.mediaType,
      role: entry.role,
    })),
  }));
}

export async function artifactDigest(artifact: ArtifactInputV1 | AgentArtifact): Promise<string> {
  return sha256(canonicalJson(withoutDigest(artifact)));
}

export async function createArtifact(input: ArtifactInputV1): Promise<AgentArtifact> {
  const validated = validateStructure(input, false);
  await validateInlineDigests(validated);
  const digest = await artifactDigest(input);
  const artifact = { ...structuredClone(input), digest };
  return validateStructure(artifact, true);
}

export async function validateArtifact(value: unknown): Promise<AgentArtifact> {
  const artifact = validateStructure(value, true);
  await validateInlineDigests(artifact);
  const expected = await artifactDigest(artifact);
  if (artifact.digest !== expected) {
    throw new DeploymentError(
      'ARTIFACT_DIGEST_MISMATCH',
      `artifact digest ${artifact.digest} does not match canonical digest ${expected}`,
      'artifact.digest',
    );
  }
  return structuredClone(artifact);
}
