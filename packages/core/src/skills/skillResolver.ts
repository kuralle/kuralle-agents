import type {
  SkillEntry,
  SkillLike,
  SkillResolver,
  SkillResolverContext,
  SkillSource,
  SkillStoreLike,
} from '../types/skills.js';
import { isPackagedSkill, type PackagedSkill } from './packagedSkill.js';
import { InlineSkillStore } from './inlineSkillStore.js';
import { materializeSkillStore } from './materializeSkillStore.js';

/**
 * `SkillEntry` has exactly one callable member: `SkillResolver`. `SkillLike` and
 * `SkillStoreLike` are plain objects, `string` is a primitive, and a packaged-skill bundle is
 * an array — none of those is ever a function — so `typeof entry === 'function'` discriminates
 * the whole union without needing a brand. Named (rather than inlined at each call site) so the
 * invariant is asserted once, here, and every caller shares the same reasoning.
 */
export function isSkillResolver(entry: SkillEntry): entry is SkillResolver {
  if (typeof entry !== 'function') return false;
  // A callable object can still satisfy `SkillStoreLike` — JavaScript lets a function carry
  // methods — and a store is not a resolver however it was constructed. Checking the store
  // contract first means the shape an author declared wins over how they happened to build it.
  const maybeStore = entry as unknown as Partial<SkillStoreLike>;
  return typeof maybeStore.list !== 'function' || typeof maybeStore.loadBody !== 'function';
}

/**
 * Normalize `SkillSource` into an ordered list of entries. A bare array is a list of entries,
 * except the special case where every element is a `PackagedSkill` — that shape is one
 * packaged bundle, not several entries (mirrors the historical `prepareSkillStore` behavior).
 */
export function normalizeSkillSource(source: SkillSource): SkillEntry[] {
  if (!Array.isArray(source)) return [source as SkillEntry];
  if (source.length > 0 && source.every(isPackagedSkill)) {
    return [source as readonly PackagedSkill[]];
  }
  return [...(source as readonly SkillEntry[])];
}

export interface SubstitutedSkillEntries {
  /** `entries` with every resolver replaced in place by the store it produced, so downstream
   *  precedence (later entries win) is unaffected by where a resolver sat in the array. */
  entries: SkillEntry[];
  /** This session's resolver output, keyed by the resolver's position in `entries`. Persist
   *  verbatim — it is what a later turn or a replay reuses instead of re-invoking the
   *  resolver against a tenant lookup that has since moved on. */
  resolvedByIndex: Record<string, SkillLike[]>;
}

/**
 * Replace every `SkillResolver` entry with the store it resolved to, in place. A resolver
 * whose index is present in `cached` is not called again — its cached output is reused
 * verbatim, which is what makes resolution "once per session" rather than once per turn.
 *
 * Collisions: two *different* resolvers producing the same skill name is an authoring error
 * (there is no ordering the author intended between two per-tenant resolutions) and throws,
 * naming both. A resolver producing a name a *static* entry also declares is not a collision
 * here — precedence for that is just array order, same as any other two entries.
 */
export async function substituteSkillResolvers(
  entries: readonly SkillEntry[],
  ctx: SkillResolverContext,
  cached: Readonly<Record<string, SkillLike[]>> | undefined,
): Promise<SubstitutedSkillEntries> {
  const resolvedByIndex: Record<string, SkillLike[]> = {};
  const producedBy = new Map<string, number>();
  const out: SkillEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!isSkillResolver(entry)) {
      out.push(entry);
      continue;
    }

    const key = String(index);
    const skills = cached && key in cached ? cached[key]! : await invokeResolver(entry, ctx);

    for (const skill of skills) {
      const producer = producedBy.get(skill.name);
      if (producer !== undefined && producer !== index) {
        throw new Error(
          `[skills] Two skill resolvers for agent "${ctx.agentId}" both produced a skill named ` +
            `"${skill.name}" (resolver #${producer} and resolver #${index}). There is no ordering ` +
            'the author intended between two resolvers — rename one of the skills.',
        );
      }
      producedBy.set(skill.name, index);
    }

    resolvedByIndex[key] = skills;
    out.push(new InlineSkillStore(skills));
  }

  return { entries: out, resolvedByIndex };
}

async function invokeResolver(
  resolver: SkillResolver,
  ctx: SkillResolverContext,
): Promise<SkillLike[]> {
  let produced: SkillLike[] | SkillStoreLike;
  try {
    produced = await resolver(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[skills] Skill resolver for agent "${ctx.agentId}" threw while resolving skills: ${message}`,
      { cause: err },
    );
  }
  if (Array.isArray(produced)) return produced;
  return (await materializeSkillStore(produced)).skills;
}
