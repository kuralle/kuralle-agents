import { z } from 'zod';
import type { FileSystem } from '../types/filesystem.js';
import { defineTool, type AnyTool } from '../types/effectTool.js';
import type { CapabilityPromptSection } from '../capabilities/index.js';
import {
  collectRegisteredNames,
  prepareSkillStore,
  validateSkillAllowedTools,
  type SkillWireAgent,
} from './collectSkills.js';
import { SkillsCapability } from './SkillsCapability.js';
import { createAgentGetSkill, type SkillHandle } from './skillHandle.js';
import { LiveSkillCatalog } from './liveSkillCatalog.js';
import type { Session } from '../types/session.js';
import type { SkillLike, SkillMeta } from '../types/skills.js';

export interface WiredAgentSkills {
  capability: SkillsCapability;
  tools: Record<string, AnyTool>;
  promptSections: CapabilityPromptSection[];
  contentHash: string;
  metas: SkillMeta[];
  /** Live catalog `load_skill` resolves against; mutated by the runtime add/remove API. */
  catalog: LiveSkillCatalog;
  getSkill: (name: string) => SkillHandle;
  /** Present only when `agent.skills` contained a `SkillResolver`: this session's resolver
   *  output, by resolver position. The caller (`buildAgentToolSurface`) persists it so a
   *  later turn reuses it instead of calling the resolver again. */
  resolvedSkillsByIndex?: Record<string, SkillLike[]>;
}

/** Session context needed to resolve a per-tenant `SkillResolver`, plus this session's
 *  previously resolved output (keyed by resolver position) so it is invoked once per
 *  session rather than once per turn. */
export interface SkillResolverContextInput {
  session: Session;
  cached?: Readonly<Record<string, SkillLike[]>>;
}

export async function wireAgentSkills(
  agent: SkillWireAgent,
  fs?: FileSystem,
  resolverInput?: SkillResolverContextInput,
): Promise<WiredAgentSkills | undefined> {
  if (!agent.skills) return undefined;

  const resolver = resolverInput
    ? {
        ctx: { session: resolverInput.session, agentId: agent.id ?? 'unknown' },
        cached: resolverInput.cached,
      }
    : undefined;

  const { store, metas, skills, contentHash, resolvedSkillsByIndex } = await prepareSkillStore(
    agent.skills,
    fs,
    resolver,
  );
  validateSkillAllowedTools(skills, collectRegisteredNames(agent));

  const catalog = new LiveSkillCatalog(store, metas);
  const capability = new SkillsCapability(catalog);
  const tools: Record<string, AnyTool> = {};

  for (const decl of capability.getTools()) {
    tools[decl.name] = defineTool({
      name: decl.name,
      description: decl.description,
      input: decl.parameters as z.ZodTypeAny,
      execute: async (args) => decl.execute(args),
    });
  }

  return {
    capability,
    tools,
    promptSections: capability.getPromptSections(),
    contentHash,
    metas,
    catalog,
    getSkill: createAgentGetSkill(store, metas),
    ...(resolvedSkillsByIndex ? { resolvedSkillsByIndex } : {}),
  };
}
