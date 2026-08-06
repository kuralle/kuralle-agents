import type { SkillMeta, SkillStoreLike } from '../types/skills.js';

/**
 * Presents several skill stores as one, with **later stores winning** a name collision.
 *
 * Delegates rather than flattening on purpose: flattening would force every body and
 * resource to load up front, which is exactly what progressive disclosure exists to avoid.
 * Only `list()` (Level 1 — names and descriptions) is eager; bodies and resources stay
 * behind their own calls.
 */
export class CompositeSkillStore implements SkillStoreLike {
  /** Name → the store that owns it. Built on first `list()`, reused after. */
  private owners?: Map<string, SkillStoreLike>;

  /** @param stores In precedence order, lowest first. */
  constructor(private readonly stores: readonly SkillStoreLike[]) {}

  async list(): Promise<SkillMeta[]> {
    const merged = new Map<string, SkillMeta>();
    const owners = new Map<string, SkillStoreLike>();
    for (const store of this.stores) {
      for (const meta of await store.list()) {
        merged.set(meta.name, meta);
        owners.set(meta.name, store);
      }
    }
    this.owners = owners;
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadBody(name: string): Promise<string> {
    return (await this.ownerOf(name)).loadBody(name);
  }

  async loadResource(name: string, path: string): Promise<string | Uint8Array> {
    return (await this.ownerOf(name)).loadResource(name, path);
  }

  async listResources(name: string): Promise<string[]> {
    const owner = await this.ownerOf(name);
    return (await owner.listResources?.(name)) ?? [];
  }

  async loadAllSkills() {
    const owners = await this.resolveOwners();
    const out = [];
    for (const [name, store] of owners) {
      out.push({ name, description: '', body: await store.loadBody(name) });
    }
    return out;
  }

  private async ownerOf(name: string): Promise<SkillStoreLike> {
    const owner = (await this.resolveOwners()).get(name);
    if (!owner) throw new Error(`[skills] Skill "${name}" not found.`);
    return owner;
  }

  private async resolveOwners(): Promise<Map<string, SkillStoreLike>> {
    if (!this.owners) await this.list();
    return this.owners!;
  }
}
