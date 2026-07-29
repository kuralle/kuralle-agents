import type { AnyTool } from '../types/effectTool.js';
import type { FileSystem } from '../types/filesystem.js';
import type { SkillEntry, SkillLike, SkillMeta, SkillSource, SkillStoreLike } from '../types/skills.js';
import { InlineSkillStore } from './inlineSkillStore.js';
import { CompositeSkillStore } from './compositeSkillStore.js';
import { fsSkillStore } from './fsSkillStore.js';
import { canonicalSkillContent, sha256 } from './contentHash.js';

export interface SkillWireAgent {
  skills?: SkillSource;
  tools?: Record<string, AnyTool>;
  globalTools?: Record<string, AnyTool>;
  flows?: Array<{ name: string }>;
}

export function isSkillStore(value: SkillEntry | SkillSource): value is SkillStoreLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'list' in value &&
    typeof (value as SkillStoreLike).list === 'function'
  );
}

async function collectSkillsFromSource(
  source: SkillStoreLike,
): Promise<{ metas: SkillMeta[]; skills: SkillLike[] }> {
  const metas = await source.list();
  const skills: SkillLike[] = [];
  for (const meta of metas) {
    const body = await source.loadBody(meta.name);
    skills.push({
      name: meta.name,
      description: meta.description,
      body,
      ...(meta.allowedTools ? { allowedTools: meta.allowedTools } : {}),
      ...(meta.contentHash ? { contentHash: meta.contentHash } : {}),
      ...(meta.path ? { path: meta.path } : {}),
    });
  }
  return { metas, skills };
}

async function hashSkillSnapshot(skills: readonly SkillLike[]): Promise<string> {
  const entries = await Promise.all(
    [...skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (skill) => `${skill.name}:${skill.contentHash ?? await sha256(canonicalSkillContent(skill))}`),
  );
  return sha256(entries.join('\n'));
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

/**
 * Turns whatever the author wrote in `AgentConfig.skills` into one store.
 *
 * `fs` is the agent's workspace filesystem, needed only to resolve `string` entries. A path
 * without a workspace is an authoring mistake, so it throws rather than silently yielding no
 * skills — a missing skill is invisible at runtime and looks like the model ignoring it.
 */
export async function prepareSkillStore(
  source: SkillSource,
  fs?: FileSystem,
): Promise<{
  store: SkillStoreLike;
  metas: SkillMeta[];
  skills: SkillLike[];
  contentHash: string;
}> {
  const entries: SkillEntry[] = Array.isArray(source)
    ? [...source]
    : [source as SkillEntry];

  // A lone store stays itself: wrapping one store in a composite would add a layer with
  // nothing to compose, and lose any extra capability the store exposes.
  if (entries.length === 1 && isSkillStore(entries[0]!)) {
    const only = entries[0] as SkillStoreLike;
    const collected = await collectSkillsFromSource(only);
    return { store: only, ...collected, contentHash: await hashSkillSnapshot(collected.skills) };
  }

  const stores: SkillStoreLike[] = [];
  let inline: SkillLike[] = [];
  const flushInline = (): void => {
    if (inline.length > 0) {
      stores.push(new InlineSkillStore(inline));
      inline = [];
    }
  };

  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (!fs) {
        throw new Error(
          `[skills] "${entry}" is a workspace path, but this agent has no \`workspace\` filesystem. ` +
            'Set `workspace` on the agent, or pass skills inline with defineSkill().',
        );
      }
      flushInline();
      stores.push(fsSkillStore(fs, [entry]));
      continue;
    }
    if (isSkillStore(entry)) {
      flushInline();
      stores.push(entry);
      continue;
    }
    // Consecutive inline skills share one store so ordering within a run is preserved.
    inline.push(entry);
  }
  flushInline();

  if (stores.length === 1) {
    const only = stores[0]!;
    const collected = await collectSkillsFromSource(only);
    return { store: only, ...collected, contentHash: await hashSkillSnapshot(collected.skills) };
  }

  const store = new CompositeSkillStore(stores);
  const collected = await collectSkillsFromSource(store);
  return { store, ...collected, contentHash: await hashSkillSnapshot(collected.skills) };
}
