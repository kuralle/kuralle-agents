export interface SkillMeta {
  name: string;
  description: string;
  /**
   * Where the skill's SKILL.md lives, when it is file-backed. Internal diagnostic metadata;
   * it is intentionally not disclosed in the model catalog because bodies must be loaded
   * through `load_skill` even when the skill store is not the agent workspace.
   */
  path?: string;
  /** SHA-256 of the source content used to build this catalog entry. */
  contentHash?: string;
  /** Enforcement metadata; never rendered into the model-facing catalog. */
  allowedTools?: string[];
}

export interface SkillLike {
  name: string;
  description: string;
  body: string;
  resources?: Record<string, string | Uint8Array>;
  allowedTools?: string[];
  /** Internal audit/cache metadata propagated by content-backed stores. */
  contentHash?: string;
  /** Source path for diagnostics; never rendered into the model prompt. */
  path?: string;
}

export interface SkillStoreLike {
  list(): Promise<SkillMeta[]>;
  loadBody(name: string): Promise<string>;
  loadResource(name: string, path: string): Promise<string | Uint8Array>;
  listResources?(name: string): Promise<string[]>;
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
