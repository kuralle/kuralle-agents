import type { SkillLike, SkillMeta, SkillStoreLike } from '../types/skills.js';
import { assertSafeSkillResourcePath } from './assertSafeSkillResourcePath.js';
import {
  skillCatalogEntries,
  type SkillCatalogEntry,
} from './skillCatalog.js';

/**
 * Persisted shape of a live catalog, stored on `runState.state.skillCatalog` so a resumed
 * or replayed run restores the exact roster it had — added skills, withdrawals, and the
 * last-announced snapshot — and neither re-resolves a withdrawn skill nor re-narrates a
 * change it already narrated.
 */
export interface PersistedLiveSkillCatalog {
  added: SkillLike[];
  removed: string[];
  announced: SkillCatalogEntry[];
}

/**
 * The mutable set of skills `load_skill` resolves against for the current run — distinct
 * from the frozen `skillPrompt` baseline, which lists only what was wired at startup and
 * must stay byte-identical (see `skillCatalog.ts` for why).
 *
 * Resolution order on a name: an added (live) skill wins; otherwise the baseline store
 * serves a baseline skill that has not been withdrawn; anything else is not available. So
 * a baseline skill's body still loads lazily through the store (progressive disclosure
 * preserved), and only added skills carry their body inline.
 *
 * The catalog is per-run instance state threaded through the run context (matching how
 * `skillActivations` is threaded), never module state.
 */
export class LiveSkillCatalog {
  private readonly added = new Map<string, SkillLike>();
  private readonly removed = new Set<string>();
  private announced: SkillCatalogEntry[];

  constructor(
    private readonly store: SkillStoreLike,
    private readonly baseline: readonly SkillMeta[],
  ) {
    this.announced = skillCatalogEntries(baseline);
  }

  /** The frozen baseline the prompt was built from. Rendered once into `skillPrompt`. */
  frozenBaseline(): readonly SkillMeta[] {
    return this.baseline;
  }

  /**
   * The current live roster (baseline ∪ added − removed), sorted by name. This is what
   * `load_skill`'s availability list and the announcement roster are derived from.
   */
  entries(): SkillCatalogEntry[] {
    const out = new Map<string, SkillCatalogEntry>();
    for (const meta of this.baseline) {
      if (!this.removed.has(meta.name)) {
        out.set(meta.name, { name: meta.name, description: meta.description });
      }
    }
    for (const skill of this.added.values()) {
      out.set(skill.name, { name: skill.name, description: skill.description });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Is `name` resolvable right now (added, or an un-withdrawn baseline skill)? */
  has(name: string): boolean {
    if (this.added.has(name)) return true;
    if (this.removed.has(name)) return false;
    return this.baseline.some((meta) => meta.name === name);
  }

  /**
   * Metadata for `name`, for activation recording (`recordSkillActivation`). Added skills
   * surface their `allowedTools` so the a3 tool boundary composes with skills activated
   * mid-run; a withdrawn skill resolves to `undefined`.
   */
  meta(name: string): SkillMeta | undefined {
    const added = this.added.get(name);
    if (added) {
      return {
        name: added.name,
        description: added.description,
        ...(added.allowedTools ? { allowedTools: [...added.allowedTools] } : {}),
      };
    }
    if (this.removed.has(name)) return undefined;
    return this.baseline.find((meta) => meta.name === name);
  }

  async loadBody(name: string): Promise<string> {
    const added = this.added.get(name);
    if (added) return added.body;
    if (!this.has(name)) {
      throw new Error(`[skills] Skill "${name}" not found.`);
    }
    return this.store.loadBody(name);
  }

  async listResources(name: string): Promise<string[]> {
    const added = this.added.get(name);
    if (added) return Object.keys(added.resources ?? {}).sort();
    if (!this.has(name)) return [];
    return (await this.store.listResources?.(name)) ?? [];
  }

  async loadResource(name: string, path: string): Promise<string | Uint8Array> {
    const added = this.added.get(name);
    if (added) {
      const normalized = assertSafeSkillResourcePath(path);
      if (normalized === 'SKILL.md') {
        throw new Error(`[skills] Resource "${normalized}" not found for skill "${name}".`);
      }
      const content = added.resources?.[normalized];
      if (content === undefined) {
        throw new Error(`[skills] Resource "${normalized}" not found for skill "${name}".`);
      }
      return content;
    }
    if (!this.has(name)) {
      throw new Error(`[skills] Skill "${name}" not found.`);
    }
    return this.store.loadResource(name, path);
  }

  /** Add (or replace) a skill in the live roster. Re-adding a withdrawn baseline skill
   *  un-withdraws it. */
  add(skill: SkillLike): void {
    this.added.set(skill.name, skill);
    this.removed.delete(skill.name);
  }

  /** Withdraw `name` from the live roster. Returns false if it was never available. */
  remove(name: string): boolean {
    if (!this.has(name)) return false;
    this.added.delete(name);
    if (this.baseline.some((meta) => meta.name === name)) {
      this.removed.add(name);
    }
    return true;
  }

  // ── announcement snapshot ────────────────────────────────────────────────────

  /** The roster as it stood after the last announcement. Diff against `entries()` to decide
   *  whether a change needs narrating. */
  announcedSnapshot(): SkillCatalogEntry[] {
    return this.announced.map((e) => ({ ...e }));
  }

  /** Record that the current `entries()` has been announced. */
  setAnnouncedSnapshot(entries: readonly SkillCatalogEntry[]): void {
    this.announced = entries.map((e) => ({ name: e.name, description: e.description }));
  }

  /**
   * Fold the current live roster into the announced baseline. Called at compaction — the
   * one place the cached prompt is already being rewritten — so the prompt can be rebased
   * to the live roster and the announcement note dropped, keeping announcement history
   * bounded instead of growing each turn.
   */
  rebaseline(): void {
    this.announced = this.entries();
  }

  // ── persistence ──────────────────────────────────────────────────────────────

  serialize(): PersistedLiveSkillCatalog {
    return {
      added: [...this.added.values()].map((s) => ({ ...s })),
      removed: [...this.removed].sort(),
      announced: this.announced.map((e) => ({ ...e })),
    };
  }

  /** Restore a previously serialized catalog. Used on run resume/replay so the live roster,
   *  withdrawals, and last-announced snapshot survive across the run boundary. */
  restore(state: PersistedLiveSkillCatalog): void {
    this.added.clear();
    for (const skill of state.added ?? []) this.added.set(skill.name, skill);
    this.removed.clear();
    for (const name of state.removed ?? []) this.removed.add(name);
    this.announced = (state.announced ?? skillCatalogEntries(this.baseline)).map((e) => ({
      name: e.name,
      description: e.description,
    }));
  }
}

/** Restore a catalog from persisted run state (`runState.state.skillCatalog`). No-op when the
 *  agent has no skills or nothing was persisted, so a fresh run starts from the baseline. */
export function restoreLiveSkillCatalog(
  catalog: LiveSkillCatalog | undefined,
  state: Record<string, unknown> | undefined,
): void {
  if (!catalog || !state) return;
  const persisted = state.skillCatalog;
  if (!persisted || typeof persisted !== 'object') return;
  catalog.restore(persisted as PersistedLiveSkillCatalog);
}
