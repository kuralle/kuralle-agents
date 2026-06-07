import type { SkillSource as CoreSkillSource } from '@kuralle-agents/core/types';

export interface SkillWireAgent {
  skills?: CoreSkillSource;
  tools?: Record<string, import('@kuralle-agents/core').AnyTool>;
  globalTools?: Record<string, import('@kuralle-agents/core').AnyTool>;
  flows?: Array<{ name: string }>;
}
import type { Skill, SkillSource } from './types.js';
import { BundledSkillStore } from './stores/bundled.js';
import { FsSkillStore } from './stores/fs.js';
import { MemorySkillStore } from './stores/memory.js';
import { isSkillStore, toSkillStore } from './toSkillStore.js';

export async function collectSkillsFromSource(source: SkillSource): Promise<Skill[]> {
  if (!isSkillStore(source)) {
    return Array.isArray(source) ? source : [source];
  }
  if (source instanceof MemorySkillStore || source instanceof BundledSkillStore) {
    return source.getAllSkills();
  }
  if (source instanceof FsSkillStore) {
    return source.loadAllSkills();
  }
  const metas = await source.list();
  const skills: Skill[] = [];
  for (const meta of metas) {
    const body = await source.loadBody(meta.name);
    skills.push({ name: meta.name, description: meta.description, body });
  }
  return skills;
}

export async function collectSkillsFromAgent(agent: SkillWireAgent): Promise<Skill[]> {
  if (!agent.skills) return [];
  return collectSkillsFromSource(agent.skills as SkillSource);
}

export function collectRegisteredNames(agent: SkillWireAgent): Set<string> {
  const names = new Set<string>();
  for (const [key, tool] of Object.entries(agent.tools ?? {})) {
    names.add(tool.name ?? key);
  }
  for (const [key, tool] of Object.entries(agent.globalTools ?? {})) {
    names.add(tool.name ?? key);
  }
  for (const flow of agent.flows ?? []) {
    names.add(flow.name);
  }
  return names;
}

export function validateSkillAllowedTools(skills: Skill[], registered: Set<string>): void {
  for (const skill of skills) {
    for (const toolName of skill.allowedTools ?? []) {
      if (!registered.has(toolName)) {
        throw new Error(`skill ${skill.name}: unknown tool ${toolName}`);
      }
    }
  }
}

export async function prepareSkillStore(source: SkillSource): Promise<{
  store: ReturnType<typeof toSkillStore>;
  skills: Skill[];
}> {
  const store = toSkillStore(source);
  const skills = await collectSkillsFromSource(source);
  return { store, skills };
}
