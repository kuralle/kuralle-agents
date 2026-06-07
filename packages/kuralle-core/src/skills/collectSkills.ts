import type { AnyTool } from '../types/effectTool.js';
import type { SkillLike, SkillSource, SkillStoreLike } from '../types/skills.js';
import { InlineSkillStore } from './inlineSkillStore.js';

export interface SkillWireAgent {
  skills?: SkillSource;
  tools?: Record<string, AnyTool>;
  globalTools?: Record<string, AnyTool>;
  flows?: Array<{ name: string }>;
}

export function isSkillStore(value: SkillSource): value is SkillStoreLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'list' in value &&
    typeof (value as SkillStoreLike).list === 'function'
  );
}

async function collectSkillsFromSource(source: SkillSource): Promise<SkillLike[]> {
  if (!isSkillStore(source)) {
    return Array.isArray(source) ? source : [source];
  }
  if (typeof source.getAllSkills === 'function') {
    const all = source.getAllSkills();
    return Array.isArray(all) ? all : await all;
  }
  if (typeof source.loadAllSkills === 'function') {
    return source.loadAllSkills();
  }
  const metas = await source.list();
  const skills: SkillLike[] = [];
  for (const meta of metas) {
    const body = await source.loadBody(meta.name);
    skills.push({ name: meta.name, description: meta.description, body });
  }
  return skills;
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

export function validateSkillAllowedTools(skills: SkillLike[], registered: Set<string>): void {
  for (const skill of skills) {
    for (const toolName of skill.allowedTools ?? []) {
      if (!registered.has(toolName)) {
        throw new Error(`skill ${skill.name}: unknown tool ${toolName}`);
      }
    }
  }
}

export async function prepareSkillStore(source: SkillSource): Promise<{
  store: SkillStoreLike;
  skills: SkillLike[];
}> {
  if (isSkillStore(source)) {
    return { store: source, skills: await collectSkillsFromSource(source) };
  }
  const skills = Array.isArray(source) ? source : [source];
  return { store: new InlineSkillStore(skills), skills };
}
