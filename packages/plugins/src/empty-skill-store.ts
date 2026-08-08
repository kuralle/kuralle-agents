import type { SkillStoreLike } from '@kuralle-agents/core';

export function emptySkillStore(): SkillStoreLike {
  return {
    list: async () => [],
    loadBody: async (name: string) => {
      throw new Error(`Skill not found: ${name}`);
    },
    loadResource: async (name: string, path: string) => {
      throw new Error(`Resource not found: ${name}/${path}`);
    },
  };
}
