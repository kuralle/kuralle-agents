import type { SkillMeta } from '../types/skills.js';

/**
 * One row of the skill catalog as the model sees it: a name and the one-line description
 * that tells it when to reach for the skill. Bodies and resources are deliberately absent —
 * those live behind `load_skill` / `read_skill_resource` (progressive disclosure).
 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
}

/**
 * The change between two catalog snapshots, computed by name. A description-only change on
 * an existing skill is neither added nor removed: the catalog announces availability
 * (present / absent), not wording edits, and rebaselining wording into the prompt is the
 * compaction step's job, not the announcement's.
 */
export interface SkillCatalogDelta {
  added: SkillCatalogEntry[];
  removed: string[];
}

/**
 * `systemNotes.ts` tag for the catalog-delta announcement, shared by `ctx.ts` (writes it on
 * add/remove) and `Runtime.ts` (retires it at compaction once the delta it announced is
 * folded into a rebaselined `skillPrompt`) so the two call sites cannot drift onto different
 * strings and silently stop recognising each other's note.
 */
export const SKILL_CATALOG_NOTE_TAG = 'skill-catalog';

/** Project skill metadata (baseline or live) down to the catalog shape the model sees. */
export function skillCatalogEntries(
  metas: readonly Pick<SkillMeta, 'name' | 'description'>[],
): SkillCatalogEntry[] {
  return metas.map((m) => ({ name: m.name, description: m.description }));
}

/**
 * Set-difference two catalogs by name. Both halves are sorted by name so the result is
 * deterministic regardless of insertion order — the announcement text and any snapshot
 * comparison must be stable.
 */
export function diffSkillCatalog(
  previous: readonly SkillCatalogEntry[],
  next: readonly SkillCatalogEntry[],
): SkillCatalogDelta {
  const prev = new Map(previous.map((e): [string, SkillCatalogEntry] => [e.name, e]));
  const nextMap = new Map(next.map((e): [string, SkillCatalogEntry] => [e.name, e]));

  const added: SkillCatalogEntry[] = [];
  for (const [name, entry] of nextMap) {
    if (!prev.has(name)) added.push({ name: entry.name, description: entry.description });
  }

  const removed: string[] = [];
  for (const name of prev.keys()) {
    if (!nextMap.has(name)) removed.push(name);
  }

  return {
    added: added.sort((a, b) => a.name.localeCompare(b.name)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Render a catalog delta as the single context block delivered to the model when the live
 * roster changes. Names what became available (with descriptions) and what was withdrawn,
 * then restates the full current roster — the roster is the durable truth; the delta only
 * draws the model's attention to the change.
 *
 * Delivered as a runtime system note (see `systemNotes.ts`), never by editing `skillPrompt`,
 * because rewriting the serialized tools/prompt block discards the provider's prompt cache
 * for the whole conversation.
 */
export function renderSkillCatalogDelta(
  delta: SkillCatalogDelta,
  roster: readonly string[],
): string {
  const lines: string[] = ['The skills available in this run changed.'];

  if (delta.added.length > 0) {
    lines.push('Newly available — call load_skill by name when the description matches:');
    for (const entry of delta.added) {
      lines.push(`- ${entry.name}: ${entry.description}`);
    }
  }

  if (delta.removed.length > 0) {
    lines.push('No longer available — do not call load_skill for these:');
    for (const name of delta.removed) {
      lines.push(`- ${name}`);
    }
  }

  const sortedRoster = [...roster].sort();
  if (sortedRoster.length > 0) {
    lines.push(`Current available skills: ${sortedRoster.join(', ')}`);
  } else {
    lines.push('No skills are currently available.');
  }

  return lines.join('\n');
}

/**
 * Fixed instruction header for the in-prompt catalog. Kept verbatim so the frozen baseline
 * (`skillPrompt`) is byte-identical to what `SkillsCapability` always produced — the only
 * thing that varies is the trailing skill list.
 */
export const SKILL_CATALOG_PROMPT_HEADER = [
  '## Available skills',
  'When a description matches the task, call load_skill with its name before acting.',
  'Listed skills are available in this run. Do not claim a listed skill is inaccessible unless activation actually fails.',
  'If multiple skills match, activate the minimal set that covers the task.',
  'After activation, follow the returned instructions rather than improvising around them.',
  'When a loaded skill mentions a sibling file such as references/foo.md, read it with read_skill_resource, not with the workspace tool.',
  'Skill bodies and resources belong to the skill capability, not the workspace: do not locate or read SKILL.md with workspace.',
  'Conversely, files under absolute workspace mounts such as /knowledge or /notes are not skill resources: use workspace for those paths.',
].join('\n');

/**
 * Render the `## Available skills` prompt section for a catalog. `undefined` for an empty
 * catalog so the caller emits no section at all — matching the contract that an agent with
 * no skills gets no catalog block.
 *
 * Used both at wire time (the frozen `skillPrompt` baseline, from `SkillsCapability`) and at
 * compaction (rebaselining the prompt from the current live roster, the one place the cached
 * prompt is already being rewritten).
 */
export function renderSkillCatalogPrompt(
  entries: readonly SkillCatalogEntry[],
): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map((e) => `- ${e.name}: ${e.description}`).join('\n');
  return `${SKILL_CATALOG_PROMPT_HEADER}\n${lines}`;
}
