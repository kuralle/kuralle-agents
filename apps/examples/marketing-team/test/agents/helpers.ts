import type { LanguageModel } from 'ai';
import { isPackagedSkill, type AgentConfig, type PackagedSkill } from '@kuralle-agents/core';
import { createLeadAgent } from '../../agent/lead.js';
import { createSpecialistAgents, SPECIALIST_IDS, type SpecialistId } from '../../agent/specialists.js';
import type { MarketingToolsDeps } from '../../agent/lib/index.js';
import type { Db } from '../../agent/lib/workspace-scope.js';

// Only tool *names* and skill *metadata* are inspected by the tests in this directory; no tool
// is ever executed and no model is ever called, so `db` and `model` are never dereferenced.
// Typed honestly (not `any`), matching the convention in `test/skills/allowed-tools.test.ts`.
const unusedDb = {} as unknown as Db;
const unusedModel = {} as unknown as LanguageModel;

export function testDeps(): MarketingToolsDeps & { model: LanguageModel } {
  return {
    db: unusedDb,
    resolveScope: () => ({ workspaceId: 'unused', principalId: 'unused' }),
    storageRoot: '/tmp/unused',
    surfaces: ['blog', 'x', 'linkedin', 'threads', 'bluesky', 'mastodon', 'email'],
    model: unusedModel,
  };
}

export interface BuiltAgents {
  lead: AgentConfig;
  specialists: AgentConfig[];
  bySpecialistId: Record<SpecialistId, AgentConfig>;
}

/** Builds the real lead + all five specialists from the real factory functions in `agent/`. */
export async function buildAllAgents(): Promise<BuiltAgents> {
  const deps = testDeps();
  const lead = createLeadAgent(deps);
  const specialists = await createSpecialistAgents(deps);
  const bySpecialistId = Object.fromEntries(
    SPECIALIST_IDS.map((id, index) => [id, specialists[index]!]),
  ) as Record<SpecialistId, AgentConfig>;
  return { lead, specialists, bySpecialistId };
}

export function toolNames(agent: AgentConfig): Set<string> {
  return new Set(Object.keys(agent.tools ?? {}));
}

/** Flattens whatever shape `AgentConfig['skills']` is into a plain list of packaged skills —
 *  our factories pass either one packaged array or an array of packaged arrays (own + shared). */
export function flattenSkills(skills: unknown): PackagedSkill[] {
  if (!skills) return [];
  if (Array.isArray(skills)) return skills.flatMap((entry) => flattenSkills(entry));
  return isPackagedSkill(skills) ? [skills] : [];
}
