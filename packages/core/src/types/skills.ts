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

import type { PackagedSkill } from '../skills/packagedSkill.js';
import type { Session } from './session.js';

export interface SkillStoreLike {
  list(): Promise<SkillMeta[]>;
  loadBody(name: string): Promise<string>;
  loadResource(name: string, path: string): Promise<string | Uint8Array>;
  listResources?(name: string): Promise<string[]>;
  getAllSkills?(): SkillLike[] | Promise<SkillLike[]>;
  loadAllSkills?(): Promise<SkillLike[]>;
}

export interface SkillResolverContext {
  session: Session;
  agentId: string;
}

/**
 * Resolves a tenant- or principal-scoped skill set at session start. Called once per session
 * (not per turn) by `buildAgentToolSurface`; its output is merged into the frozen baseline the
 * same way a statically declared entry is, then persisted so a later turn or a replay reuses
 * the result instead of re-invoking the resolver against a tenant lookup that may have moved on.
 */
export type SkillResolver = (
  ctx: SkillResolverContext,
) => SkillLike[] | SkillStoreLike | Promise<SkillLike[] | SkillStoreLike>;

/**
 * One way to supply skills. A `string` is a filesystem root scanned for
 * `<dir>/SKILL.md`, resolved against the agent's `workspace` filesystem. A `SkillResolver`
 * function resolves per-session/per-tenant skills; it is the only callable member of this
 * union (see `isSkillResolver`).
 */
export type SkillEntry =
  | SkillLike
  | SkillStoreLike
  | string
  | readonly PackagedSkill[]
  | SkillResolver;

/**
 * Skills for an agent: one entry, or an ordered array mixing inline skills, stores,
 * workspace paths, and resolvers. **Later entries win** on a name collision, so layering
 * reads in the order you write it:
 *
 * ```ts
 * skills: ['/.agents/skills/org', '/.agents/skills/team', defineSkill({ name: 'override', … })]
 * ```
 *
 * Two `SkillResolver` entries producing the same skill name is different: there is no
 * ordering the author intended between two per-tenant resolutions, so it throws instead of
 * picking a winner.
 */
export type SkillSource = SkillEntry | ReadonlyArray<SkillEntry>;
