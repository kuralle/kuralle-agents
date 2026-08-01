import {
  parseSkillFrontmatter,
  type AgentConfig,
  type AnyTool,
  type DeploymentTraceContext,
  type Flow,
  type Policy,
  type RefinementCapability,
  type ValidationCapability,
} from '@kuralle-agents/core';
import type {
  InputProcessor,
  OutputProcessor,
  SkillLike,
  SkillMeta,
  SkillStoreLike,
} from '@kuralle-agents/core/types';
import { validateArtifact } from './artifact.js';
import { sha256 } from './canonical.js';
import { DeploymentError } from './errors.js';
import { assertArtifactCompatible } from './preflight.js';
import { NamedRegistry, VersionedRegistry } from './registry.js';
import type {
  AgentArtifact,
  AgentVersion,
  BuiltinToolReference,
  ClientToolReference,
  ContentEntry,
  HttpToolReference,
  McpToolReference,
  RuntimeRevision,
  ThreadPin,
} from './types.js';

type Model = NonNullable<AgentConfig['model']>;

export interface ArtifactContentResolver {
  read(ref: string): Promise<string | Uint8Array>;
}

export interface ArtifactResolver {
  get(artifactId: string, digest: string): Promise<AgentArtifact>;
}

export interface SecretResolver {
  resolve(alias: string, generation: number): Promise<string>;
}

export interface ToolBindingContext {
  pin: ThreadPin;
  secret(alias: string): Promise<string>;
}

export interface ToolReferenceResolvers {
  http?: (reference: HttpToolReference, context: ToolBindingContext) => AnyTool | Promise<AnyTool>;
  mcp?: (reference: McpToolReference, context: ToolBindingContext) => AnyTool | Promise<AnyTool>;
  builtin?: (reference: BuiltinToolReference, context: ToolBindingContext) => AnyTool | Promise<AnyTool>;
  client?: (reference: ClientToolReference, context: ToolBindingContext) => AnyTool | Promise<AnyTool>;
}

export interface RuntimeBindings {
  models: NamedRegistry<Model>;
  tools: VersionedRegistry<AnyTool>;
  flows: VersionedRegistry<Flow>;
  toolReferences?: ToolReferenceResolvers;
  inputPolicies?: VersionedRegistry<InputProcessor>;
  outputPolicies?: VersionedRegistry<OutputProcessor>;
  toolPolicies?: VersionedRegistry<Policy>;
  refiners?: VersionedRegistry<RefinementCapability>;
  validators?: VersionedRegistry<ValidationCapability>;
  content?: ArtifactContentResolver;
  artifacts?: ArtifactResolver;
  secrets?: SecretResolver;
}

export interface BoundAgentRevision {
  artifact: AgentArtifact;
  agent: AgentConfig;
  deployment: DeploymentTraceContext;
  references: readonly ContentEntry[];
  workspaceSeed: readonly ContentEntry[];
}

function bindingError(message: string): never {
  throw new DeploymentError('BINDING_FAILED', message);
}

function bytes(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function readEntry(
  entry: ContentEntry,
  resolver: ArtifactContentResolver | undefined,
): Promise<Uint8Array> {
  const value = entry.content.kind === 'inline'
    ? entry.content.text
    : await (resolver?.read(entry.content.ref) ?? bindingError(`no content resolver for ${entry.path}`));
  const result = bytes(value);
  if (result.byteLength !== entry.bytes) {
    throw new DeploymentError('CONTENT_INVALID', `byte length mismatch for ${entry.path}`, entry.path);
  }
  if (await sha256(result) !== entry.digest) {
    throw new DeploymentError('CONTENT_INVALID', `digest mismatch for ${entry.path}`, entry.path);
  }
  return result;
}

async function readText(
  entry: ContentEntry,
  resolver: ArtifactContentResolver | undefined,
): Promise<string> {
  if (!entry.mediaType.startsWith('text/') && entry.mediaType !== 'application/json') {
    throw new DeploymentError('CONTENT_INVALID', `${entry.path} is not textual content`, entry.path);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await readEntry(entry, resolver));
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError('CONTENT_INVALID', `${entry.path} is not valid UTF-8`, entry.path);
  }
}

function safeResourcePath(root: string, resource: string): string {
  if (
    resource.length === 0 ||
    resource.startsWith('/') ||
    resource.includes('\\') ||
    resource.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    return bindingError(`invalid skill resource path ${resource}`);
  }
  return root ? `${root}/${resource}` : resource;
}

class ArtifactSkillStore implements SkillStoreLike {
  constructor(
    private readonly artifact: AgentArtifact,
    private readonly resolver: ArtifactContentResolver | undefined,
  ) {}

  async list(): Promise<SkillMeta[]> {
    return this.artifact.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      path: skill.entrypoint,
      contentHash: skill.digest,
    }));
  }

  async loadBody(name: string): Promise<string> {
    return (await this.loadParsed(name)).body;
  }

  async loadResource(name: string, path: string): Promise<string | Uint8Array> {
    const skill = this.artifact.skills.find(candidate => candidate.name === name);
    if (!skill) return bindingError(`skill ${name} is not in the pinned artifact`);
    const slash = skill.entrypoint.lastIndexOf('/');
    const root = slash < 0 ? '' : skill.entrypoint.slice(0, slash);
    const target = safeResourcePath(root, path);
    const entry = skill.files.find(candidate => candidate.path === target);
    if (!entry || entry.path === skill.entrypoint) {
      return bindingError(`resource ${path} is not packaged by skill ${name}`);
    }
    const content = await readEntry(entry, this.resolver);
    return entry.mediaType.startsWith('text/') || entry.mediaType === 'application/json'
      ? new TextDecoder('utf-8', { fatal: true }).decode(content)
      : content;
  }

  async getAllSkills(): Promise<SkillLike[]> {
    const result: SkillLike[] = [];
    for (const skill of this.artifact.skills) {
      const parsed = await this.loadParsed(skill.name);
      const slash = skill.entrypoint.lastIndexOf('/');
      const root = slash < 0 ? '' : skill.entrypoint.slice(0, slash);
      const prefix = root ? `${root}/` : '';
      const resources: Record<string, string | Uint8Array> = {};
      for (const entry of skill.files) {
        if (entry.path === skill.entrypoint) continue;
        const relative = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
        resources[relative] = await this.loadResource(skill.name, relative);
      }
      result.push({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        resources,
        allowedTools: parsed.allowedTools,
        contentHash: skill.digest,
        path: skill.entrypoint,
      });
    }
    return result;
  }

  private async loadParsed(name: string) {
    const skill = this.artifact.skills.find(candidate => candidate.name === name);
    if (!skill) return bindingError(`skill ${name} is not in the pinned artifact`);
    const entry = skill.files.find(candidate => candidate.path === skill.entrypoint);
    if (!entry) return bindingError(`skill ${name} has no packaged entrypoint`);
    const parsed = parseSkillFrontmatter(await readText(entry, this.resolver), { path: entry.path });
    if (parsed.name !== skill.name || parsed.description !== skill.description) {
      return bindingError(`skill metadata for ${name} does not match its artifact catalog`);
    }
    return parsed;
  }
}

function deploymentContext(pin: ThreadPin): DeploymentTraceContext {
  return {
    tenantId: pin.tenantId,
    agentEntityId: pin.agentEntityId,
    agentVersionId: pin.agentVersionId,
    artifactDigest: pin.artifactDigest,
    releaseId: pin.releaseId,
    runtimeRevisionId: pin.runtimeRevisionId,
    environment: pin.environment,
    branch: pin.branch,
    configGeneration: pin.configGeneration,
    secretGeneration: pin.secretGeneration,
  };
}

function verifyPin(version: AgentVersion, pin: ThreadPin, runtime: RuntimeRevision): void {
  if (
    version.tenantId !== pin.tenantId ||
    version.agentEntityId !== pin.agentEntityId ||
    version.id !== pin.agentVersionId ||
    version.artifact.digest !== pin.artifactDigest ||
    runtime.id !== pin.runtimeRevisionId
  ) {
    bindingError('thread pin does not match the requested agent/runtime revision');
  }
}

async function bindArtifact(
  artifact: AgentArtifact,
  pin: ThreadPin,
  runtime: RuntimeRevision,
  bindings: RuntimeBindings,
  ancestors: ReadonlySet<string>,
): Promise<AgentConfig> {
  const validated = await validateArtifact(artifact);
  assertArtifactCompatible(validated, runtime);
  if (ancestors.has(validated.digest)) bindingError(`subagent cycle at ${validated.agent.id}`);
  const nextAncestors = new Set(ancestors).add(validated.digest);
  const declaredSecrets = new Set(validated.secretRefs.map(secret => secret.alias));
  const context: ToolBindingContext = {
    pin,
    secret: async (alias) => {
      if (!declaredSecrets.has(alias)) bindingError(`secret ${alias} is not declared by the artifact`);
      if (!bindings.secrets) bindingError(`no secret resolver is configured for ${alias}`);
      return bindings.secrets.resolve(alias, pin.secretGeneration);
    },
  };

  const tools: Record<string, AnyTool> = {};
  for (const reference of validated.tools) {
    let tool: AnyTool;
    if (reference.kind === 'trusted') {
      tool = bindings.tools.resolve(reference.capability, reference.versionRange);
    } else {
      const resolver = bindings.toolReferences?.[reference.kind];
      if (!resolver) bindingError(`no ${reference.kind} tool resolver is configured for ${reference.id}`);
      // The discriminated lookup cannot preserve the correlated function argument
      // across the index access, so dispatch each concrete resolver explicitly.
      if (reference.kind === 'http') tool = await bindings.toolReferences!.http!(reference, context);
      else if (reference.kind === 'mcp') tool = await bindings.toolReferences!.mcp!(reference, context);
      else if (reference.kind === 'builtin') tool = await bindings.toolReferences!.builtin!(reference, context);
      else tool = await bindings.toolReferences!.client!(reference, context);
    }
    if (tool.name !== reference.id) {
      bindingError(`bound tool ${tool.name} does not match artifact id ${reference.id}`);
    }
    tools[reference.id] = tool;
  }

  const flows = validated.flows.map(reference => {
    const flow = bindings.flows.resolve(reference.capability, reference.versionRange);
    if (flow.name !== reference.id) {
      bindingError(`bound flow ${flow.name} does not match artifact id ${reference.id}`);
    }
    return flow;
  });

  const childAgents: AgentConfig[] = [];
  for (const node of validated.agents) {
    if (!bindings.artifacts) bindingError(`no artifact resolver is configured for subagent ${node.id}`);
    const child = await bindings.artifacts.get(node.artifactId, node.digest);
    if (child.artifactId !== node.artifactId || child.digest !== node.digest || child.agent.id !== node.id) {
      bindingError(`resolved subagent ${node.id} does not match its pinned artifact reference`);
    }
    childAgents.push(await bindArtifact(child, pin, runtime, bindings, nextAncestors));
  }

  const instructionParts: string[] = [];
  for (const entry of validated.instructions) {
    instructionParts.push(await readText(entry, bindings.content));
  }

  const config: AgentConfig = {
    id: validated.agent.id,
    name: validated.agent.name,
    description: validated.agent.description,
    instructions: instructionParts.join('\n\n'),
    model: bindings.models.resolve(validated.agent.model),
    controlModel: validated.agent.controlModel
      ? bindings.models.resolve(validated.agent.controlModel)
      : undefined,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    flows: flows.length > 0 ? flows : undefined,
    agents: childAgents.length > 0 ? childAgents : undefined,
    handoffs: validated.agent.handoffs,
    limits: validated.agent.limits,
    skills: validated.skills.length > 0 ? new ArtifactSkillStore(validated, bindings.content) : undefined,
    guardrails: {
      input: validated.policies.input
        ? [bindings.inputPolicies?.resolve(
            validated.policies.input.capability,
            validated.policies.input.versionRange,
          ) ?? bindingError('no input policy registry is configured')]
        : undefined,
      output: validated.policies.output
        ? [bindings.outputPolicies?.resolve(
            validated.policies.output.capability,
            validated.policies.output.versionRange,
          ) ?? bindingError('no output policy registry is configured')]
        : undefined,
    },
    policy: validated.policies.tool
      ? bindings.toolPolicies?.resolve(
          validated.policies.tool.capability,
          validated.policies.tool.versionRange,
        ) ?? bindingError('no tool policy registry is configured')
      : undefined,
    refine: validated.policies.refine
      ? [bindings.refiners?.resolve(
          validated.policies.refine.capability,
          validated.policies.refine.versionRange,
        ) ?? bindingError('no refinement registry is configured')]
      : undefined,
    validate: validated.policies.validate
      ? [bindings.validators?.resolve(
          validated.policies.validate.capability,
          validated.policies.validate.versionRange,
        ) ?? bindingError('no validation registry is configured')]
      : undefined,
  };
  if (!config.guardrails?.input && !config.guardrails?.output) delete config.guardrails;
  return config;
}

export async function bindAgentVersion(options: {
  version: AgentVersion;
  pin: ThreadPin;
  runtime: RuntimeRevision;
  bindings: RuntimeBindings;
}): Promise<BoundAgentRevision> {
  verifyPin(options.version, options.pin, options.runtime);
  const artifact = await validateArtifact(options.version.artifact);
  const agent = await bindArtifact(artifact, options.pin, options.runtime, options.bindings, new Set());
  return {
    artifact,
    agent,
    deployment: deploymentContext(options.pin),
    references: structuredClone(artifact.references),
    workspaceSeed: structuredClone(artifact.workspaceSeed),
  };
}
