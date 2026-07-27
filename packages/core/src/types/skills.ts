export interface SkillMeta {
  name: string;
  description: string;
  /**
   * Where the skill's SKILL.md lives, when it is file-backed. Surfaced in the available-skills
   * catalog so the model can read the file directly rather than inferring a location.
   * Undefined for inline skills, which have no file.
   */
  path?: string;
}

export interface SkillLike {
  name: string;
  description: string;
  body: string;
  resources?: Record<string, string | Uint8Array>;
  allowedTools?: string[];
}

export interface SkillStoreLike {
  list(): Promise<SkillMeta[]>;
  loadBody(name: string): Promise<string>;
  loadResource(name: string, path: string): Promise<string | Uint8Array>;
  getAllSkills?(): SkillLike[] | Promise<SkillLike[]>;
  loadAllSkills?(): Promise<SkillLike[]>;
}

/**
 * One way to supply skills. A `string` is a filesystem root scanned for
 * `<dir>/SKILL.md`, resolved against the agent's `workspace` filesystem.
 */
export type SkillEntry = SkillLike | SkillStoreLike | string;

/**
 * Skills for an agent: one entry, or an ordered array mixing inline skills, stores, and
 * workspace paths. **Later entries win** on a name collision, so layering reads in the
 * order you write it:
 *
 * ```ts
 * skills: ['/skills/org', '/skills/team', defineSkill({ name: 'override', … })]
 * ```
 */
export type SkillSource = SkillEntry | ReadonlyArray<SkillEntry>;
