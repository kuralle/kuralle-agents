import { z } from 'zod';
import type { FileSystem } from '../types/filesystem.js';
import { defineTool, type AnyTool } from '../types/effectTool.js';
import type { PromptSection } from '../capabilities/index.js';
import {
  collectRegisteredNames,
  prepareSkillStore,
  validateSkillAllowedTools,
  type SkillWireAgent,
} from './collectSkills.js';
import { SkillsCapability } from './SkillsCapability.js';
import { createAgentGetSkill, type SkillHandle } from './skillHandle.js';
import type { SkillMeta } from '../types/skills.js';

export interface WiredAgentSkills {
  capability: SkillsCapability;
  tools: Record<string, AnyTool>;
  promptSections: PromptSection[];
  contentHash: string;
  metas: SkillMeta[];
  getSkill: (name: string) => SkillHandle;
}

export async function wireAgentSkills(
  agent: SkillWireAgent,
  fs?: FileSystem,
): Promise<WiredAgentSkills | undefined> {
  if (!agent.skills) return undefined;

  const { store, metas, skills, contentHash } = await prepareSkillStore(agent.skills, fs);
  validateSkillAllowedTools(skills, collectRegisteredNames(agent));

  const capability = new SkillsCapability(store, metas);
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
    getSkill: createAgentGetSkill(store, metas),
  };
}
