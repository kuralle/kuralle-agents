import type { SkillLike } from '../types/skills.js';
import { validateSkillDescription, validateSkillName } from './parseSkillFrontmatter.js';

export interface DefineSkillConfig {
  /** Lowercase, hyphen-separated, ≤64 chars — the Agent Skills naming rule. */
  name: string;
  /** When the model should reach for this skill. Disclosed up front, so keep it specific. ≤1024 chars. */
  description: string;
  /** The skill body — Level 2, loaded only when the model calls `load_skill`. */
  instructions: string;
  /** Level 3: fetched individually via `read_skill_resource`, never loaded up front. */
  resources?: Record<string, string | Uint8Array>;
  /** Restricts this skill to a subset of the agent's tools. Unknown names fail at wiring time. */
  allowedTools?: string[];
}

/**
 * Authors a skill inline, with no filesystem involved.
 *
 * Validated against the same rules as a `SKILL.md` on disk — an inline skill that would be
 * rejected as a file is rejected here too, so moving one to `agents/<id>/skills/` later
 * cannot start failing.
 */
export function defineSkill(config: DefineSkillConfig): SkillLike {
  const name = config.name?.trim();
  const description = config.description?.trim();
  if (!name) throw new Error('[skills] defineSkill requires a non-empty name.');
  if (!description) {
    throw new Error(`[skills] Skill "${name}" requires a non-empty description.`);
  }
  validateSkillName(name, name);
  validateSkillDescription(description, name);

  // `allowedTools: []` is ambiguous: an author plausibly means "this skill may use no tools
  // at all", but the runtime reads an empty list as "no restriction" (see `recordSkillActivation`
  // and `permittedToolNames`, both of which treat `?.length` as "declares nothing"). Frontmatter
  // parsing already normalises an empty list to `undefined`, so the only way to reach this is in
  // code — where it is almost certainly a mistake. Reject it at authoring time rather than guess.
  if (config.allowedTools !== undefined && config.allowedTools.length === 0) {
    throw new Error(
      `[skills] Skill "${name}" set allowedTools: [] — this is ambiguous. ` +
        'Omit the field entirely to impose no restriction, or list the tools this skill may use.',
    );
  }

  return {
    name,
    description,
    body: config.instructions,
    resources: config.resources,
    allowedTools: config.allowedTools,
  };
}
