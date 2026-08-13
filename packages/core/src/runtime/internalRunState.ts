/**
 * Framework-owned run state, kept out of reach of caller-supplied data.
 *
 * `runState.state` is a shared bag: flows read and write their own keys there, and
 * `openRun` shallow-merges a caller-supplied `selection.formData` into it. That is fine for
 * flow data — it is what the bag is for — but framework internals living alongside it means a
 * request body can overwrite them.
 *
 * That was not theoretical. Before this module, a request carrying
 * `formData: { resolvedSkills: { <agentId>: { "0": [...] } } }` replaced the per-tenant skill
 * snapshot wholesale: the resolver never ran, the tenant's real skills vanished from the
 * prompt, and attacker-chosen skill names and bodies reached the model in their place.
 *
 * Two defences, deliberately overlapping:
 *
 *  1. **Namespace.** Every framework internal lives under one reserved key, so a caller would
 *     have to name that key specifically rather than colliding with an internal by accident.
 *  2. **Strip.** `openRun` removes the reserved key from incoming `formData` before merging, so
 *     naming it deliberately does not work either.
 *
 * The namespace alone would still be guessable; the strip alone would protect only the keys
 * someone remembered to list. Together, a new internal added later is protected by
 * construction rather than by anyone remembering to update a denylist — which is the failure
 * mode a hand-maintained list of reserved names always eventually hits.
 */

/** The single reserved key under which all framework-owned run state lives. */
export const INTERNAL_STATE_KEY = '__kuralle' as const;

/** Framework-owned slice of `runState.state`. Add new internals here, never at the root. */
export interface InternalRunState {
  /** Per-agent, per-resolver-position snapshot of resolved skills (a6). */
  resolvedSkills?: Record<string, unknown>;
  /** Serialized live skill catalog (a5). */
  skillCatalog?: unknown;
  /** Serialized live flow-catalog announcement snapshot (per run, not the roster). */
  flowCatalog?: unknown;
}

/** Read the framework slice. Never throws; absent state reads as empty. */
export function readInternalState(
  state: Record<string, unknown> | undefined,
): Readonly<InternalRunState> {
  const slice = state?.[INTERNAL_STATE_KEY];
  return isRecord(slice) ? (slice as InternalRunState) : {};
}

/** Mutate the framework slice in place, creating it when absent. */
export function withInternalState(
  state: Record<string, unknown>,
  mutate: (internal: InternalRunState) => void,
): void {
  const existing = state[INTERNAL_STATE_KEY];
  const internal: InternalRunState = isRecord(existing) ? (existing as InternalRunState) : {};
  mutate(internal);
  state[INTERNAL_STATE_KEY] = internal;
}

/**
 * Caller-supplied form data with the reserved key removed.
 *
 * Returns the input untouched when it carries no reserved key, so the common path allocates
 * nothing. When it does, the key is dropped and the caller is warned — a request naming a
 * framework-internal namespace is either a mistake worth surfacing or an attempt worth logging,
 * and silently discarding it would hide both.
 */
export function stripInternalKeys(
  formData: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(formData, INTERNAL_STATE_KEY)) return formData;
  const { [INTERNAL_STATE_KEY]: rejected, ...safe } = formData;
  void rejected;
  console.warn(
    `[runtime] Ignoring "${INTERNAL_STATE_KEY}" in caller-supplied formData: that key is ` +
      'reserved for framework run state and cannot be set by a request.',
  );
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
