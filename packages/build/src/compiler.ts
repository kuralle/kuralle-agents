import { readdir, lstat, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseSkillFrontmatter, assertValidFlowDefinition, flowDefinitionSchema } from '@kuralle-agents/core';
import {
  createArtifact,
  sha256,
  skillPackageDigest,
  type AgentArtifact,
  type ArtifactInputV1,
  type CapabilityReference,
  type ContentEntry,
  type InlineFlowEntry,
  type PolicyArtifact,
  type SkillArtifact,
} from '@kuralle-agents/deployment';
import { AgentBuildError } from './errors.js';
import { analyzeModule } from './module-analysis.js';
import {
  DEFAULT_BUILD_QUOTAS,
  type ArtifactBlob,
  type BuildDiagnostic,
  type BuildQuotas,
  type CapabilityModule,
  type CompileAgentDirectoryOptions,
  type CompiledAgentProject,
  type SerializableAgentFile,
} from './types.js';

const ROOT_SLOTS = new Set([
  'instructions.md',
  'agent.json',
  'tools',
  'flows',
  'policies.ts',
  'skills',
  'references',
  'workspace',
  'subagents',
]);
const FILE_SLOTS = new Set(['instructions.md', 'agent.json', 'policies.ts']);
const POLICY_EXPORTS = ['input', 'output', 'tool', 'refine', 'validate'] as const;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];

interface CompileState {
  root: string;
  options: CompileAgentDirectoryOptions;
  quotas: BuildQuotas;
  diagnostics: BuildDiagnostic[];
  modules: CapabilityModule[];
  artifacts: AgentArtifact[];
  blobs: Map<string, ArtifactBlob>;
  foldedPaths: Map<string, string>;
  files: number;
  totalBytes: number;
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

function sourcePath(state: CompileState, absolute: string): string {
  return portablePath(relative(state.root, absolute));
}

function diagnostic(
  state: CompileState,
  code: BuildDiagnostic['code'],
  path: string,
  message: string,
): void {
  state.diagnostics.push({ severity: 'error', code, path, message });
}

async function trackedFile(state: CompileState, absolute: string): Promise<Uint8Array | null> {
  const path = sourcePath(state, absolute);
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    diagnostic(state, 'PATH_INVALID', path, error instanceof Error ? error.message : 'cannot read file');
    return null;
  }
  if (stats.isSymbolicLink()) {
    diagnostic(state, 'SYMLINK_REJECTED', path, 'symlinks are not allowed in agent sources');
    return null;
  }
  if (!stats.isFile()) {
    diagnostic(state, 'PATH_INVALID', path, 'expected a regular file');
    return null;
  }
  const folded = path.normalize('NFC').toLocaleLowerCase('en-US');
  const prior = state.foldedPaths.get(folded);
  if (prior && prior !== path) {
    diagnostic(state, 'CASE_COLLISION', path, `path collides with ${prior} after normalization`);
  } else {
    state.foldedPaths.set(folded, path);
  }
  state.files += 1;
  state.totalBytes += stats.size;
  if (state.files > state.quotas.maxFiles) {
    diagnostic(state, 'FILE_QUOTA_EXCEEDED', path, `project exceeds ${state.quotas.maxFiles} files`);
  }
  if (stats.size > state.quotas.maxFileBytes) {
    diagnostic(state, 'FILE_QUOTA_EXCEEDED', path, `file exceeds ${state.quotas.maxFileBytes} bytes`);
    return null;
  }
  if (state.totalBytes > state.quotas.maxTotalBytes) {
    diagnostic(state, 'FILE_QUOTA_EXCEEDED', path, `project exceeds ${state.quotas.maxTotalBytes} bytes`);
  }
  return new Uint8Array(await readFile(absolute));
}

function decodedText(
  state: CompileState,
  bytes: Uint8Array,
  path: string,
): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) {
        diagnostic(state, 'CREDENTIAL_DETECTED', path, 'source appears to contain a credential value');
        break;
      }
    }
    return text;
  } catch {
    diagnostic(state, 'PATH_INVALID', path, 'expected valid UTF-8 text');
    return null;
  }
}

function mediaType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    csv: 'text/csv',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return types[extension] ?? 'application/octet-stream';
}

function isTextMedia(type: string): boolean {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/yaml';
}

async function contentEntry(
  state: CompileState,
  absolute: string,
  localPath: string,
  role: ContentEntry['role'],
): Promise<ContentEntry | null> {
  const data = await trackedFile(state, absolute);
  if (!data) return null;
  const type = mediaType(localPath);
  const digest = await sha256(data);
  if (isTextMedia(type) && data.byteLength <= state.quotas.inlineTextBytes) {
    const text = decodedText(state, data, sourcePath(state, absolute));
    if (text === null) return null;
    return {
      path: localPath,
      digest,
      bytes: data.byteLength,
      mediaType: type,
      role,
      content: { kind: 'inline', text },
    };
  }
  state.blobs.set(digest, {
    digest,
    sourcePath: resolve(absolute),
    bytes: data.byteLength,
    mediaType: type,
  });
  return {
    path: localPath,
    digest,
    bytes: data.byteLength,
    mediaType: type,
    role,
    content: { kind: 'blob', ref: `sha256:${digest}` },
  };
}

async function sortedEntries(absolute: string) {
  return (await readdir(absolute, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function walkFiles(
  state: CompileState,
  absolute: string,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await sortedEntries(absolute)) {
    const child = join(absolute, entry.name);
    const path = sourcePath(state, child);
    if (entry.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', path, 'symlinks are not allowed in agent sources');
    } else if (entry.isDirectory()) {
      result.push(...await walkFiles(state, child));
    } else if (entry.isFile()) {
      result.push(child);
    } else {
      diagnostic(state, 'PATH_INVALID', path, 'only regular files and directories are allowed');
    }
  }
  return result;
}

function moduleId(path: string, directory: 'tools' | 'flows'): string {
  return path
    .slice(`${directory}/`.length)
    .replace(/\.[cm]?tsx?$/, '')
    .split('/')
    .join('.');
}

function isTopLevelFlowJson(agentPath: string): boolean {
  const parts = agentPath.split('/');
  return parts.length === 2 && parts[0] === 'flows' && parts[1]!.endsWith('.flow.json');
}

function flowSchemaIssuePath(parsed: ReturnType<typeof flowDefinitionSchema.safeParse>): string {
  if (parsed.success) return '';
  const issue = parsed.error.issues[0];
  if (!issue || issue.path.length === 0) return '';
  return issue.path.map(String).join('.');
}

function flowSchemaIssueMessage(parsed: ReturnType<typeof flowDefinitionSchema.safeParse>): string {
  if (parsed.success) return 'invalid flow definition';
  const issue = parsed.error.issues[0];
  const path = flowSchemaIssuePath(parsed);
  if (!issue) return 'invalid flow definition';
  return path ? `${path}: ${issue.message}` : issue.message;
}

async function compileModules(
  state: CompileState,
  agentDir: string,
  capabilityOwner: string,
  directory: 'tools' | 'flows',
): Promise<{ references: CapabilityReference[]; sourceMap: ArtifactInputV1['sourceMap'] }> {
  const absoluteDirectory = join(agentDir, directory);
  const references: CapabilityReference[] = [];
  const sourceMap: ArtifactInputV1['sourceMap'] = [];
  try {
    const stats = await lstat(absoluteDirectory);
    if (stats.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', sourcePath(state, absoluteDirectory), 'symlinks are not allowed');
      return { references, sourceMap };
    }
    if (!stats.isDirectory()) {
      diagnostic(state, 'PATH_INVALID', sourcePath(state, absoluteDirectory), 'expected a directory');
      return { references, sourceMap };
    }
  } catch {
    return { references, sourceMap };
  }
  for (const absolute of await walkFiles(state, absoluteDirectory)) {
    const projectPath = sourcePath(state, absolute);
    const agentPath = portablePath(relative(agentDir, absolute));
    if (!/\.tsx?$/.test(agentPath)) {
      if (directory === 'flows' && isTopLevelFlowJson(agentPath)) continue;
      diagnostic(
        state,
        'UNKNOWN_SLOT',
        projectPath,
        directory === 'flows'
          ? `${directory} may contain only .ts, .tsx, or top-level .flow.json files`
          : `${directory} may contain only .ts or .tsx modules`,
      );
      continue;
    }
    const data = await trackedFile(state, absolute);
    if (!data) continue;
    const text = decodedText(state, data, projectPath);
    if (text === null) continue;
    const analysis = analyzeModule({
      sourceText: text,
      path: projectPath,
      target: state.options.target,
      requiredExports: ['default'],
      allowedExports: ['default'],
    });
    state.diagnostics.push(...analysis.diagnostics);
    const id = moduleId(agentPath, directory);
    const singular = directory === 'tools' ? 'tool' : 'flow';
    const capability = `${capabilityOwner}:${singular}:${id}`;
    const version = state.options.capabilityVersion ?? '1.0.0';
    const digest = await sha256(data);
    references.push({ id, capability, versionRange: `=${version}` });
    state.modules.push({
      kind: singular,
      id,
      capability,
      version,
      sourcePath: resolve(absolute),
      exportName: 'default',
      digest,
    });
    sourceMap.push({ source: agentPath, target: `${singular}:${id}`, digest });
  }
  return { references, sourceMap };
}

async function compileInlineFlows(
  state: CompileState,
  agentDir: string,
): Promise<{ entries: InlineFlowEntry[]; sourceMap: ArtifactInputV1['sourceMap'] }> {
  const entries: InlineFlowEntry[] = [];
  const sourceMap: ArtifactInputV1['sourceMap'] = [];
  const absoluteDirectory = join(agentDir, 'flows');
  try {
    const stats = await lstat(absoluteDirectory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { entries, sourceMap };
  } catch {
    return { entries, sourceMap };
  }
  for (const entry of await sortedEntries(absoluteDirectory)) {
    if (!entry.name.endsWith('.flow.json')) continue;
    const absolute = join(absoluteDirectory, entry.name);
    const projectPath = sourcePath(state, absolute);
    const agentPath = portablePath(relative(agentDir, absolute));
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) {
      diagnostic(state, 'PATH_INVALID', projectPath, 'expected a regular file');
      continue;
    }
    const data = await trackedFile(state, absolute);
    if (!data) continue;
    const text = decodedText(state, data, projectPath);
    if (text === null) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      diagnostic(
        state,
        'FLOW_INVALID',
        projectPath,
        error instanceof Error ? error.message : 'invalid JSON',
      );
      continue;
    }
    const parsed = flowDefinitionSchema.safeParse(json);
    if (!parsed.success) {
      diagnostic(
        state,
        'FLOW_INVALID',
        projectPath,
        flowSchemaIssueMessage(parsed),
      );
      continue;
    }
    try {
      assertValidFlowDefinition(parsed.data);
    } catch (error) {
      diagnostic(
        state,
        'FLOW_INVALID',
        projectPath,
        error instanceof Error ? error.message : 'invalid flow definition',
      );
      continue;
    }
    const digest = await sha256(data);
    entries.push({ kind: 'inline', id: parsed.data.name, definition: parsed.data });
    sourceMap.push({ source: agentPath, target: `flow:${parsed.data.name}`, digest });
  }
  return { entries, sourceMap };
}

async function compilePolicies(
  state: CompileState,
  agentDir: string,
  capabilityOwner: string,
): Promise<{ policies: PolicyArtifact; sourceMap: ArtifactInputV1['sourceMap'] }> {
  const absolute = join(agentDir, 'policies.ts');
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', sourcePath(state, absolute), 'symlinks are not allowed');
      return { policies: {}, sourceMap: [] };
    }
  } catch {
    return { policies: {}, sourceMap: [] };
  }
  const data = await trackedFile(state, absolute);
  if (!data) return { policies: {}, sourceMap: [] };
  const projectPath = sourcePath(state, absolute);
  const text = decodedText(state, data, projectPath);
  if (text === null) return { policies: {}, sourceMap: [] };
  const analysis = analyzeModule({
    sourceText: text,
    path: projectPath,
    target: state.options.target,
    requiredExports: [],
    allowedExports: POLICY_EXPORTS,
  });
  state.diagnostics.push(...analysis.diagnostics);
  if (![...analysis.exports].some(name => POLICY_EXPORTS.includes(name as typeof POLICY_EXPORTS[number]))) {
    diagnostic(state, 'MODULE_EXPORT_INVALID', projectPath, 'policies.ts must export at least one policy phase');
  }
  const digest = await sha256(data);
  const version = state.options.capabilityVersion ?? '1.0.0';
  const policies: PolicyArtifact = {};
  const sourceMap: ArtifactInputV1['sourceMap'] = [];
  for (const name of POLICY_EXPORTS) {
    if (!analysis.exports.has(name)) continue;
    const capability = `${capabilityOwner}:policy:${name}`;
    policies[name] = { id: name, capability, versionRange: `=${version}` };
    state.modules.push({
      kind: 'policy',
      id: name,
      capability,
      version,
      sourcePath: resolve(absolute),
      exportName: name,
      digest,
    });
    sourceMap.push({ source: 'policies.ts', target: `policy:${name}`, digest });
  }
  return { policies, sourceMap };
}

async function compileContentDirectory(
  state: CompileState,
  agentDir: string,
  directory: 'references' | 'workspace',
  role: ContentEntry['role'],
): Promise<ContentEntry[]> {
  const absoluteDirectory = join(agentDir, directory);
  try {
    const stats = await lstat(absoluteDirectory);
    if (stats.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', sourcePath(state, absoluteDirectory), 'symlinks are not allowed');
      return [];
    }
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }
  const entries: ContentEntry[] = [];
  for (const absolute of await walkFiles(state, absoluteDirectory)) {
    const localPath = portablePath(relative(agentDir, absolute));
    const entry = await contentEntry(state, absolute, localPath, role);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function compileSkills(state: CompileState, agentDir: string): Promise<SkillArtifact[]> {
  const skillsDirectory = join(agentDir, 'skills');
  try {
    const stats = await lstat(skillsDirectory);
    if (stats.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', sourcePath(state, skillsDirectory), 'symlinks are not allowed');
      return [];
    }
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }
  const skills: SkillArtifact[] = [];
  for (const directory of await sortedEntries(skillsDirectory)) {
    const absoluteSkill = join(skillsDirectory, directory.name);
    const projectPath = sourcePath(state, absoluteSkill);
    if (directory.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', projectPath, 'symlinks are not allowed');
      continue;
    }
    if (!directory.isDirectory()) {
      diagnostic(state, 'UNKNOWN_SLOT', projectPath, 'skills/ may contain only skill directories');
      continue;
    }
    const files: ContentEntry[] = [];
    for (const absolute of await walkFiles(state, absoluteSkill)) {
      const localPath = portablePath(relative(agentDir, absolute));
      const entry = await contentEntry(state, absolute, localPath, 'skill');
      if (entry) files.push(entry);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const entrypoint = `skills/${directory.name}/SKILL.md`;
    const skillMd = files.find(file => file.path === entrypoint);
    if (!skillMd) {
      diagnostic(state, 'SKILL_INVALID', projectPath, 'skill directory must contain SKILL.md');
      continue;
    }
    if (skillMd.content.kind !== 'inline') {
      diagnostic(state, 'SKILL_INVALID', entrypoint, 'SKILL.md must fit the inline text quota');
      continue;
    }
    try {
      const parsed = parseSkillFrontmatter(skillMd.content.text, { path: entrypoint });
      if (parsed.name !== directory.name) {
        diagnostic(state, 'SKILL_INVALID', entrypoint, `skill name must match directory ${directory.name}`);
        continue;
      }
      const withoutDigest = {
        name: parsed.name,
        description: parsed.description,
        entrypoint,
        files,
      };
      skills.push({ ...withoutDigest, digest: await skillPackageDigest(withoutDigest) });
    } catch (error) {
      diagnostic(state, 'SKILL_INVALID', entrypoint, error instanceof Error ? error.message : 'invalid skill');
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function parseAgentFile(
  state: CompileState,
  path: string,
  text: string,
): SerializableAgentFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    diagnostic(state, 'AGENT_CONFIG_INVALID', path, error instanceof Error ? error.message : 'invalid JSON');
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostic(state, 'AGENT_CONFIG_INVALID', path, 'agent.json must contain an object');
    return {};
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(['id', 'name', 'description', 'model', 'controlModel', 'limits', 'handoffs']);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) diagnostic(state, 'AGENT_CONFIG_INVALID', path, `unknown agent.json field ${key}`);
  }
  return object as SerializableAgentFile;
}

async function compileOne(
  state: CompileState,
  agentDir: string,
  lineage: string[],
  depth: number,
): Promise<AgentArtifact | null> {
  const directoryId = basename(agentDir);
  const artifactId = [state.options.artifactIdPrefix ?? 'agent', ...lineage].join('.');
  if (depth > state.quotas.maxDepth) {
    diagnostic(state, 'FILE_QUOTA_EXCEEDED', sourcePath(state, agentDir), `subagent depth exceeds ${state.quotas.maxDepth}`);
    return null;
  }
  let rootEntries;
  try {
    rootEntries = await sortedEntries(agentDir);
  } catch (error) {
    diagnostic(state, 'PATH_INVALID', sourcePath(state, agentDir), error instanceof Error ? error.message : 'cannot read agent directory');
    return null;
  }
  for (const entry of rootEntries) {
    if (!ROOT_SLOTS.has(entry.name)) {
      diagnostic(state, 'UNKNOWN_SLOT', sourcePath(state, join(agentDir, entry.name)), `unknown agent slot ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      diagnostic(state, 'SYMLINK_REJECTED', sourcePath(state, join(agentDir, entry.name)), 'symlinks are not allowed');
    } else if (ROOT_SLOTS.has(entry.name)) {
      const expectedFile = FILE_SLOTS.has(entry.name);
      if ((expectedFile && !entry.isFile()) || (!expectedFile && !entry.isDirectory())) {
        diagnostic(
          state,
          'PATH_INVALID',
          sourcePath(state, join(agentDir, entry.name)),
          expectedFile ? 'expected a regular file' : 'expected a directory',
        );
      }
    }
  }

  let config: SerializableAgentFile = {};
  let configDigest: string | undefined;
  const configPath = join(agentDir, 'agent.json');
  try {
    const stats = await lstat(configPath);
    if (stats.isFile() && !stats.isSymbolicLink()) {
      const data = await trackedFile(state, configPath);
      if (data) {
        configDigest = await sha256(data);
        const text = decodedText(state, data, sourcePath(state, configPath));
        if (text !== null) config = parseAgentFile(state, sourcePath(state, configPath), text);
      }
    }
  } catch {
    // agent.json is optional.
  }
  const agentId = config.id ?? directoryId;
  if (config.id && config.id !== directoryId) {
    diagnostic(state, 'AGENT_CONFIG_INVALID', sourcePath(state, configPath), `agent id must match directory ${directoryId}`);
  }

  const instructionsPath = join(agentDir, 'instructions.md');
  let instructions: ContentEntry | null = null;
  try {
    const stats = await lstat(instructionsPath);
    if (stats.isFile() && !stats.isSymbolicLink()) {
      instructions = await contentEntry(state, instructionsPath, 'instructions.md', 'instructions');
    }
  } catch {
    // Required-file diagnostic is emitted below.
  }
  if (!instructions && !state.diagnostics.some(entry =>
    entry.path === sourcePath(state, instructionsPath) && entry.code === 'INSTRUCTIONS_MISSING')) {
    diagnostic(state, 'INSTRUCTIONS_MISSING', sourcePath(state, instructionsPath), 'instructions.md is required and must be valid');
  }

  // Keep discovery order deterministic. These routines share quota and
  // case-fold collision state, so parallel reads would make the diagnostic
  // attached to the threshold/collision depend on I/O scheduling.
  const toolResult = await compileModules(state, agentDir, artifactId, 'tools');
  const inlineFlowResult = await compileInlineFlows(state, agentDir);
  const flowResult = await compileModules(state, agentDir, artifactId, 'flows');
  const policyResult = await compilePolicies(state, agentDir, artifactId);
  const skills = await compileSkills(state, agentDir);
  const references = await compileContentDirectory(state, agentDir, 'references', 'reference');
  const workspaceSeed = await compileContentDirectory(state, agentDir, 'workspace', 'workspace-seed');

  const childArtifacts: AgentArtifact[] = [];
  const subagentsDirectory = join(agentDir, 'subagents');
  try {
    const subagentStats = await lstat(subagentsDirectory);
    if (!subagentStats.isDirectory() || subagentStats.isSymbolicLink()) throw new Error('not a directory');
    for (const entry of await sortedEntries(subagentsDirectory)) {
      const childPath = join(subagentsDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostic(state, 'SYMLINK_REJECTED', sourcePath(state, childPath), 'symlinks are not allowed');
      } else if (!entry.isDirectory()) {
        diagnostic(state, 'UNKNOWN_SLOT', sourcePath(state, childPath), 'subagents/ may contain only agent directories');
      } else {
        const child = await compileOne(state, childPath, [...lineage, entry.name], depth + 1);
        if (child) childArtifacts.push(child);
      }
    }
  } catch {
    // subagents/ is optional.
  }

  if (!instructions) return null;
  const requiredCapabilities = [
    ...toolResult.references.map(reference => ({ capability: reference.capability, versionRange: reference.versionRange })),
    ...flowResult.references.map(reference => ({ capability: reference.capability, versionRange: reference.versionRange })),
    ...Object.values(policyResult.policies)
      .filter((reference): reference is CapabilityReference => reference !== undefined)
      .map(reference => ({ capability: reference.capability, versionRange: reference.versionRange })),
  ].sort((a, b) => a.capability.localeCompare(b.capability));
  const sourceMap = [
    ...(configDigest ? [{ source: 'agent.json', target: 'agent', digest: configDigest }] : []),
    { source: 'instructions.md', target: 'instructions', digest: instructions.digest },
    ...toolResult.sourceMap,
    ...inlineFlowResult.sourceMap,
    ...flowResult.sourceMap,
    ...policyResult.sourceMap,
    ...skills.flatMap(skill => skill.files.map(file => ({
      source: file.path,
      target: `skill:${skill.name}:${file.path}`,
      digest: file.digest,
    }))),
    ...references.map(file => ({ source: file.path, target: `reference:${file.path}`, digest: file.digest })),
    ...workspaceSeed.map(file => ({ source: file.path, target: `workspace:${file.path}`, digest: file.digest })),
  ].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  try {
    const artifact = await createArtifact({
      schemaVersion: 1,
      artifactId,
      compiler: { name: 'kuralle', version: state.options.compilerVersion },
      runtimeApiRange: state.options.runtimeApiRange,
      agent: {
        id: agentId,
        name: config.name,
        description: config.description,
        model: config.model ?? state.options.defaultModel,
        controlModel: config.controlModel,
        limits: config.limits,
        handoffs: config.handoffs,
      },
      instructions: [instructions],
      skills,
      references,
      workspaceSeed,
      agents: childArtifacts.map(child => ({
        id: child.agent.id,
        artifactId: child.artifactId,
        digest: child.digest,
      })),
      tools: toolResult.references.map(reference => ({ kind: 'trusted' as const, ...reference })),
      flows: [...inlineFlowResult.entries, ...flowResult.references]
        .sort((a, b) => a.id.localeCompare(b.id)),
      policies: policyResult.policies,
      requiredCapabilities,
      secretRefs: [],
      sourceMap,
    });
    state.artifacts.push(artifact);
    return artifact;
  } catch (error) {
    diagnostic(
      state,
      'AGENT_CONFIG_INVALID',
      sourcePath(state, agentDir),
      error instanceof Error ? error.message : 'artifact validation failed',
    );
    return null;
  }
}

export async function compileAgentDirectory(
  directory: string,
  options: CompileAgentDirectoryOptions,
): Promise<CompiledAgentProject> {
  const root = resolve(directory);
  const state: CompileState = {
    root,
    options,
    quotas: { ...DEFAULT_BUILD_QUOTAS, ...options.quotas },
    diagnostics: [],
    modules: [],
    artifacts: [],
    blobs: new Map(),
    foldedPaths: new Map(),
    files: 0,
    totalBytes: 0,
  };
  const rootArtifact = await compileOne(state, root, [basename(root)], 0);
  state.diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  if (!rootArtifact || state.diagnostics.length > 0) throw new AgentBuildError(state.diagnostics);
  state.modules.sort((a, b) => a.capability.localeCompare(b.capability));
  state.artifacts.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  return {
    rootArtifact,
    artifacts: state.artifacts,
    modules: state.modules,
    blobs: [...state.blobs.values()].sort((a, b) => a.digest.localeCompare(b.digest)),
    diagnostics: state.diagnostics,
  };
}
