import type { SkillLike, SkillMeta, SkillStoreLike } from '../types/skills.js';

/** Load every skill a store lists into plain `SkillLike[]` data (name, description, body,
 *  and passthrough metadata). Used wherever a store's contents must become JSON-serializable
 *  (content hashing, persisting a resolver's output) rather than lazily disclosed. */
export async function materializeSkillStore(
  source: SkillStoreLike,
): Promise<{ metas: SkillMeta[]; skills: SkillLike[] }> {
  const metas = await source.list();
  const skills: SkillLike[] = [];
  for (const meta of metas) {
    const body = await source.loadBody(meta.name);
    // Carry the resources across too. Materializing drops the store's lazy accessors, so a
    // resolver that returned a STORE would otherwise lose every reference file: the briefing
    // would advertise nothing and `read_skill_resource` would report them unavailable, with
    // no error anywhere to say why.
    const resources = await materializeResources(source, meta.name);
    skills.push({
      name: meta.name,
      description: meta.description,
      body,
      ...(resources ? { resources } : {}),
      ...(meta.allowedTools ? { allowedTools: meta.allowedTools } : {}),
      ...(meta.contentHash ? { contentHash: meta.contentHash } : {}),
      ...(meta.path ? { path: meta.path } : {}),
    });
  }
  return { metas, skills };
}

/**
 * Read every resource a store lists for one skill into an in-memory map.
 *
 * A store that does not implement `listResources` has none to carry; a resource that fails to
 * load is skipped rather than aborting the whole materialization, because one unreadable
 * reference file should not cost the agent an otherwise-working skill.
 */
async function materializeResources(
  source: SkillStoreLike,
  name: string,
): Promise<Record<string, string | Uint8Array> | undefined> {
  const paths = await source.listResources?.(name);
  if (!paths || paths.length === 0) return undefined;
  const resources: Record<string, string | Uint8Array> = {};
  for (const path of paths) {
    try {
      resources[path] = await source.loadResource(name, path);
    } catch {
      // skipped deliberately — see doc comment
    }
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}
