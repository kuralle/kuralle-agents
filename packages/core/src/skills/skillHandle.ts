import type { SkillMeta, SkillStoreLike } from '../types/skills.js';
import { assertSafeSkillResourcePath } from './assertSafeSkillResourcePath.js';

export interface SkillFileHandle {
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export interface SkillHandle {
  readonly name: string;
  file(relativePath: string): SkillFileHandle;
}

const NO_SKILLS_ERROR = '[skills] This agent has no skills configured.';

function formatUnavailableSkill(name: string, metas: readonly SkillMeta[]): string {
  const names = metas.map((meta) => meta.name).sort();
  if (names.length === 0) {
    return `Skill "${name}" is not available. No skills are available.`;
  }
  return `Skill "${name}" is not available. Available skills: ${names.join(', ')}.`;
}

export function createSkillHandle(store: SkillStoreLike, name: string): SkillHandle {
  return {
    name,
    file(relativePath: string): SkillFileHandle {
      const normalized = assertSafeSkillResourcePath(relativePath);
      return {
        async text(): Promise<string> {
          const content = await store.loadResource(name, normalized);
          if (typeof content === 'string') return content;
          return new TextDecoder('utf-8').decode(content);
        },
        async bytes(): Promise<Uint8Array> {
          const content = await store.loadResource(name, normalized);
          if (typeof content === 'string') return new TextEncoder().encode(content);
          return content;
        },
      };
    },
  };
}

export function createAgentGetSkill(
  store: SkillStoreLike,
  metas: readonly SkillMeta[],
): (name: string) => SkillHandle {
  const metaNames = new Set(metas.map((meta) => meta.name));
  return (name: string): SkillHandle => {
    if (!metaNames.has(name)) {
      throw new Error(formatUnavailableSkill(name, metas));
    }
    return createSkillHandle(store, name);
  };
}

export function createNoSkillsGetSkill(): (name: string) => SkillHandle {
  return () => {
    throw new Error(NO_SKILLS_ERROR);
  };
}
