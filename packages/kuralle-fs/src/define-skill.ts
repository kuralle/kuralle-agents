import type { SkillLike } from '@kuralle-agents/core';

export function defineSkill(opts: {
  name: string;
  description: string;
  instructions: string;
  resources?: Record<string, string>;
}): SkillLike {
  return {
    name: opts.name,
    description: opts.description,
    body: opts.instructions,
    resources: opts.resources,
  };
}