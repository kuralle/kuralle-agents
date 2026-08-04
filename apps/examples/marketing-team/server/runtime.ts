import { join } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { createRuntime, type AgentConfig, type Runtime } from '@kuralle-agents/core';
import { eq } from 'drizzle-orm';
import type { LanguageModel } from 'ai';
import { createLeadAgent } from '../agent/lead.js';
import { createSpecialistAgents } from '../agent/specialists.js';
import type { MarketingToolsDeps } from '../agent/lib/index.js';
import type { WorkspaceScope } from '../agent/lib/workspace-scope.js';
import { db } from '../db/client.js';
import { workspaces } from '../db/schema.js';

const WORKSPACE_NAME = 'Acme Marketing';
const STORAGE_ROOT = join(import.meta.dir, '..', 'storage');
const SURFACES = ['blog', 'x', 'linkedin', 'threads', 'bluesky', 'mastodon', 'email'] as const;

let workspaceIdPromise: Promise<string> | undefined;

/**
 * This app is single-tenant: one seeded workspace, resolved here by a fixed name and cached
 * for the process lifetime. Every HTTP route and every agent tool call resolves its scope
 * through this function alone — never from a request parameter, header, or model output — so
 * a workspace id can never arrive as caller-supplied input (see agent/lib/workspace-scope.ts,
 * "the classic cross-tenant seam").
 */
export function resolveDefaultWorkspaceId(): Promise<string> {
  workspaceIdPromise ??= (async () => {
    const [existing] = await db.select().from(workspaces).where(eq(workspaces.name, WORKSPACE_NAME)).limit(1);
    if (existing) return existing.id;
    const [created] = await db.insert(workspaces).values({ name: WORKSPACE_NAME }).returning();
    if (!created) throw new Error('resolveDefaultWorkspaceId: insert returned no row');
    return created.id;
  })();
  return workspaceIdPromise;
}

/** Shared by the agent runtime and every REST route — the one set of tool deps for this app. */
export function marketingToolsDeps(): MarketingToolsDeps {
  return {
    db,
    storageRoot: STORAGE_ROOT,
    surfaces: SURFACES,
    resolveScope: async (): Promise<WorkspaceScope> => ({
      workspaceId: await resolveDefaultWorkspaceId(),
      principalId: 'web',
    }),
  };
}

let runtimePromise: Promise<Runtime> | undefined;

export function getRuntime(): Promise<Runtime> {
  runtimePromise ??= buildRuntime();
  return runtimePromise;
}

async function buildRuntime(): Promise<Runtime> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required. Add it to apps/examples/marketing-team/.env (see .env.example).',
    );
  }
  const modelId = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
  const model: LanguageModel = createOpenAI({ apiKey })(modelId);
  const deps = { ...marketingToolsDeps(), model };

  const lead = createLeadAgent(deps);
  const specialists = await createSpecialistAgents(deps);
  const agents: AgentConfig[] = [lead, ...specialists];

  return createRuntime({ agents, defaultAgentId: lead.id, defaultModel: model });
}
