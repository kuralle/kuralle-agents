import type { RunContext } from '../types/run-context.js';
import type { SkillMeta } from '../types/skills.js';
import {
  ALLOW,
  type Policy,
} from '../runtime/policies/toolPolicy.js';

export const FRAMEWORK_SKILL_TOOLS: readonly string[] = ['load_skill', 'read_skill_resource'];

export interface SkillActivation {
  name: string;
  allowedTools?: readonly string[];
}

/**
 * Union of every declaring active skill's allowed tools plus framework skill tools.
 * Returns `null` when unrestricted — not an empty set (empty means nothing is allowed).
 *
 * A skill with no `allowed-tools` imposes no restriction and does not widen one: if skill A
 * declares `alpha` and skill B declares nothing, the permitted set is `{alpha} ∪ framework`,
 * not unrestricted. Loading a second unconstrained skill must not dissolve an active boundary.
 *
 * `allowed-tools` is a guard-rail for an honest model that makes mistakes, not a boundary
 * against an adversarial one: `load_skill` is always permitted, and the permitted set is the
 * union across active skills, so a model restricted by skill A can activate skill B and gain
 * B's tools. A missed activation (wrong name, or the model chose not to load) restricts
 * nothing. For an unconditional restriction, set an agent `policy`.
 */
export function permittedToolNames(active: readonly SkillActivation[]): Set<string> | null {
  const declaring = active.filter((s) => s.allowedTools?.length);
  if (declaring.length === 0) return null;

  const set = new Set<string>(FRAMEWORK_SKILL_TOOLS);
  for (const skill of declaring) {
    for (const toolName of skill.allowedTools!) {
      set.add(toolName);
    }
  }
  return set;
}

/**
 * Policy that denies any tool call outside the union of active skills' `allowed-tools`.
 *
 * `allowed-tools` is a guard-rail for an honest model that makes mistakes, not a boundary
 * against an adversarial one. For an unconditional restriction, set an agent `policy`: it
 * composes deny-wins with this one, so a denial it imposes cannot be widened by the model
 * loading another skill.
 */
export function skillRestrictionPolicy(getActive: () => readonly SkillActivation[]): Policy {
  return {
    decide: (req) => {
      const permitted = permittedToolNames(getActive());
      if (permitted === null) return ALLOW;
      if (permitted.has(req.toolName)) return ALLOW;

      const declaring = getActive().filter((s) => s.allowedTools?.length);
      const toolList = [...permitted].sort().join(', ');
      const reason =
        declaring.length === 1
          ? `The active skill "${declaring[0]!.name}" restricts tool use to: ${toolList}.`
          : `Active skills (${declaring.map((s) => s.name).join(', ')}) restrict tool use to: ${toolList}.`;

      return { kind: 'deny', reason };
    },
  };
}

export function isSuccessfulLoadSkillResult(result: unknown): boolean {
  return typeof result === 'string' && result.includes('<skill_instructions>');
}

export function recordSkillActivation(
  active: SkillActivation[],
  meta: Pick<SkillMeta, 'name' | 'allowedTools'>,
): void {
  if (!meta.allowedTools?.length) return;
  const entry: SkillActivation = { name: meta.name, allowedTools: meta.allowedTools };
  const index = active.findIndex((s) => s.name === meta.name);
  if (index >= 0) active[index] = entry;
  else active.push(entry);
}

export function resetSkillActivations(active: SkillActivation[]): void {
  active.length = 0;
}

/**
 * Clears turn-scoped skill activations. Called at the start of every node turn
 * (`TextDriver.runAgentTurn` and `runSilentExtraction`), so within a multi-node flow a
 * skill activated in node A imposes nothing in node B even during one user turn.
 *
 * That is the intended semantics: each flow node is a distinct planning unit with its own
 * node-scoped instructions, so a restriction the model established for one node's task must
 * not silently shape a different node's. Each node decides afresh whether to `load_skill`.
 */
export function resetSkillActivationsOnTurnStart(ctx: RunContext): void {
  if (ctx.skillActivations) resetSkillActivations(ctx.skillActivations);
}
