import { defineTool, type AnyTool } from '@kuralle-agents/core';
import type { PromptSection } from '@kuralle-agents/core/capabilities';
import { z } from 'zod';
import { SkillsCapability } from './SkillsCapability.js';
import {
  collectRegisteredNames,
  prepareSkillStore,
  validateSkillAllowedTools,
  type SkillWireAgent,
} from './collectSkills.js';

export interface WiredAgentSkills {
  capability: SkillsCapability;
  tools: Record<string, AnyTool>;
  promptSections: PromptSection[];
}

export async function wireAgentSkills(agent: SkillWireAgent): Promise<WiredAgentSkills | undefined> {
  if (!agent.skills) return undefined;

  const { store, skills } = await prepareSkillStore(agent.skills as import('./types.js').SkillSource);
  validateSkillAllowedTools(skills, collectRegisteredNames(agent));

  const metas = await store.list();
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
  };
}
