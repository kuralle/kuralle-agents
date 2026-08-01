import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { MemoryStore, type AgentConfig } from '@kuralle-agents/core';
import {
  embeddedArtifactContentResolver,
  InMemoryDeploymentStore,
  NamedRegistry,
  VersionedRegistry,
  type AgentArtifact,
  type RuntimeBindings,
  type RuntimeCapability,
  type RuntimeRevision,
} from '@kuralle-agents/deployment';
import { nodeArtifactWorkspaceProvider } from '@kuralle-agents/deployment/node';
import type {
  DeploymentRouterOptions,
  ThreadExecutionCoordinator,
} from '@kuralle-agents/hono-server';

interface GeneratedDeployment {
  artifactBlobs: Record<string, string>;
  artifacts: AgentArtifact[];
  rootArtifactDigest: string;
  runtimeRevisionSeed: string;
  runtimeCapabilities: readonly RuntimeCapability[];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function localCoordinator(): ThreadExecutionCoordinator {
  const owners = new Map<string, string>();
  return {
    async acquire({ tenantId, threadId, ownerId }) {
      const key = `${tenantId}:${threadId}`;
      if (owners.has(key)) return null;
      owners.set(key, ownerId);
      return {
        async renew() {
          if (owners.get(key) !== ownerId) throw new Error('thread execution lease was lost');
        },
        async release() {
          if (owners.get(key) === ownerId) owners.delete(key);
        },
      };
    },
  };
}

export default async function createHost(
  generated: GeneratedDeployment,
): Promise<DeploymentRouterOptions> {
  const apiToken = requiredEnvironment('KURALLE_EXAMPLE_TOKEN');
  const openai = createOpenAI({ apiKey: requiredEnvironment('OPENAI_API_KEY') });
  const artifact = generated.artifacts.find(item => item.digest === generated.rootArtifactDigest);
  if (!artifact) throw new Error('generated root artifact is missing');

  const models = new NamedRegistry<NonNullable<AgentConfig['model']>>();
  const modelIds = new Set(generated.artifacts.flatMap(item => (
    [item.agent.model, item.agent.controlModel].filter((id): id is string => Boolean(id))
  )));
  for (const modelId of modelIds) {
    const [provider, ...name] = modelId.split('/');
    if (provider !== 'openai' || name.length === 0) {
      throw new Error(`example host only supports openai/<model>, received ${modelId}`);
    }
    models.register(modelId, openai(name.join('/')));
  }

  const bindings: RuntimeBindings = {
    models,
    tools: new VersionedRegistry(),
    flows: new VersionedRegistry(),
    content: embeddedArtifactContentResolver(generated.artifactBlobs),
    artifacts: {
      async get(artifactId, digest) {
        const match = generated.artifacts.find(item => item.artifactId === artifactId && item.digest === digest);
        if (!match) throw new Error(`artifact ${artifactId}@${digest} is not in this deployment`);
        return match;
      },
    },
    workspace: nodeArtifactWorkspaceProvider({
      root: resolve(process.env.KURALLE_WORKSPACE_ROOT ?? '.kuralle/workspaces'),
    }),
  };
  const deploymentStore = new InMemoryDeploymentStore();
  const createdAt = new Date().toISOString();
  const runtimeRevision: RuntimeRevision = {
    id: `runtime-${generated.runtimeRevisionSeed.slice(0, 24)}`,
    artifactSchemaVersions: [1],
    runtimeApiVersion: '1.0.0',
    capabilities: [...generated.runtimeCapabilities],
    createdAt,
  };
  const versionId = `${artifact.agent.id}-version-1`;
  const releaseId = `${artifact.agent.id}-release-1`;

  await deploymentStore.createEntity({
    id: artifact.agent.id,
    tenantId: 'example',
    slug: artifact.agent.id,
    status: 'active',
    ownerId: 'example',
    visibility: 'tenant',
    activeVersionId: versionId,
    createdAt,
  });
  await deploymentStore.createVersion({
    id: versionId,
    tenantId: 'example',
    agentEntityId: artifact.agent.id,
    version: 1,
    artifact,
    createdBy: 'example',
    createdAt,
  });
  await deploymentStore.registerRuntime(runtimeRevision);
  await deploymentStore.createRelease({
    id: releaseId,
    tenantId: 'example',
    agentEntityId: artifact.agent.id,
    environment: 'production',
    allocations: [{
      agentVersionId: versionId,
      runtimeRevisionId: runtimeRevision.id,
      weight: 10_000,
    }],
    createdAt,
  });
  await deploymentStore.routeTrafficTo('example', releaseId);

  return {
    deploymentStore,
    sessionStore: new MemoryStore(),
    runtimeRevision,
    bindings,
    coordinator: localCoordinator(),
    resolvePrincipal: context => bearerMatches(context.req.header('authorization'), apiToken)
      ? { tenantId: 'example', userId: 'cli-user' }
      : null,
  };
}
