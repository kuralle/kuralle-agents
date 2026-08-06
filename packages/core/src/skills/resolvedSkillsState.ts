import type { SkillLike } from '../types/skills.js';
import { readInternalState, withInternalState } from '../runtime/internalRunState.js';

/** Per-agent, per-resolver-position snapshot of what each `SkillResolver` produced this
 *  session, persisted on `runState.state.resolvedSkills`. A later turn (or a replay) reads
 *  this instead of re-invoking a resolver against a tenant lookup that may have moved on. */
export type PersistedResolvedSkills = Record<string, Record<string, SkillLike[]>>;

/** This agent's previously resolved skills for the session, if any. */
export function readResolvedSkillsCache(
  state: Record<string, unknown> | undefined,
  agentId: string,
): Readonly<Record<string, SkillLike[]>> | undefined {
  const all = readInternalState(state).resolvedSkills as PersistedResolvedSkills | undefined;
  return all?.[agentId];
}

/**
 * Merge this agent's freshly-computed resolver snapshot into the persisted map. Returns
 * whether anything actually changed, so the caller only pays for a durable write when the
 * snapshot is new (matching the "re-running the same change does not re-write" discipline
 * `ctx.ts`'s catalog announcement already follows) — not on every turn of a long session.
 */
export function mergeResolvedSkills(
  state: Record<string, unknown>,
  agentId: string,
  snapshot: Record<string, SkillLike[]>,
): boolean {
  const all = (readInternalState(state).resolvedSkills as PersistedResolvedSkills | undefined) ?? {};
  const existing = all[agentId];
  if (existing && JSON.stringify(existing) === JSON.stringify(snapshot)) return false;
  withInternalState(state, (internal) => {
    internal.resolvedSkills = { ...all, [agentId]: snapshot };
  });
  return true;
}
