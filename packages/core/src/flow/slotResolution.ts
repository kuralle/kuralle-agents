import type { CollectNode, CollectResolverSpec, FlowState, SlotSource } from '../types/flow.js';
import { FLOW_INPUT_KEY } from '../flows/definition/rehydrate.js';
import { resolveScopePath } from '../flows/template.js';

export interface DeterministicSlotResult {
  resolved: Record<string, unknown>;
  ambiguous: string[];
  slotSources: Record<string, SlotSource>;
}

export function resolveDeterministicSlots(
  node: CollectNode,
  args: { userText: string; state: FlowState; missing: readonly string[] },
): DeterministicSlotResult {
  const resolved: Record<string, unknown> = {};
  const ambiguous: string[] = [];
  const slotSources: Record<string, SlotSource> = {};
  const missing = new Set(args.missing);
  if (!node.resolvers?.length || missing.size === 0) {
    return { resolved, ambiguous, slotSources };
  }

  for (const spec of node.resolvers) {
    if (!missing.has(spec.field) || spec.field in resolved || ambiguous.includes(spec.field)) {
      continue;
    }
    const outcome = applyResolver(spec, args.userText, args.state);
    if (outcome.kind === 'hit') {
      resolved[spec.field] = outcome.value;
      slotSources[spec.field] = 'deterministic';
      missing.delete(spec.field);
      continue;
    }
    if (outcome.kind === 'ambiguous') {
      ambiguous.push(spec.field);
      missing.delete(spec.field);
    }
  }

  return { resolved, ambiguous, slotSources };
}

/**
 * Drop model-extracted values that cannot be found in the source turn.
 *
 * The guard applies ONLY to fields the node declares in `verbatimFields`. It compares the
 * extracted value against the raw turn text, so it can only judge slots the user is
 * expected to quote — an account id, an order number, a name. Extraction otherwise
 * normalises: "next Friday" becomes an ISO date, "four" becomes 4, a spoken complaint
 * becomes a written summary, and a list-reply payload never appears in the turn text at
 * all. Guarding those by containment drops correct values, and a dropped required field
 * stalls the collect node until it exhausts maxTurns. Declaring the guarded fields keeps
 * the anti-fabrication property where lexical evidence means something.
 *
 * No source text (undefined or blank) skips the guard — scripted merges with empty
 * history still accept values.
 */
export function filterByProvenance(
  incoming: Record<string, unknown>,
  sourceText: string | undefined,
  guardedFields: readonly string[] | undefined,
): { accepted: Record<string, unknown>; dropped: string[] } {
  const guarded = guardedFields && guardedFields.length > 0 ? new Set(guardedFields) : undefined;
  if (!guarded || sourceText === undefined || sourceText.trim() === '') {
    return { accepted: incoming, dropped: [] };
  }
  const accepted: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (!fieldPopulated(value)) {
      continue;
    }
    if (!guarded.has(key) || valueHasProvenance(value, sourceText)) {
      accepted[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { accepted, dropped };
}

export function valueHasProvenance(value: unknown, sourceText: string): boolean {
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return extractNumbers(sourceText).some((n) => n === value);
  }
  if (typeof value === 'string') {
    const needle = value.trim().toLowerCase();
    if (!needle) {
      return false;
    }
    return sourceText.toLowerCase().includes(needle);
  }
  return true;
}

type ResolverOutcome =
  | { kind: 'hit'; value: unknown }
  | { kind: 'ambiguous' }
  | { kind: 'miss' };

function applyResolver(spec: CollectResolverSpec, userText: string, state: FlowState): ResolverOutcome {
  switch (spec.kind) {
    case 'enum_check':
      return matchEnum(userText, spec.values);
    case 'range':
      return matchRange(userText, spec.min, spec.max);
    case 'jsonpath':
      return matchJsonPath(spec.path, state);
  }
}

function matchEnum(userText: string, values: string[]): ResolverOutcome {
  const tokens = tokenize(userText);
  if (tokens.length === 0 || values.length === 0) {
    return { kind: 'miss' };
  }

  const exact = values.filter((value) => {
    const needle = value.trim().toLowerCase();
    return needle.length > 0 && tokens.includes(needle);
  });
  const uniqueExact = uniquePreserve(exact);
  if (uniqueExact.length === 1) {
    return { kind: 'hit', value: uniqueExact[0] };
  }
  if (uniqueExact.length > 1) {
    return { kind: 'ambiguous' };
  }

  const prefixHits = values.filter((value) => {
    const needle = value.trim().toLowerCase();
    return needle.length > 0 && tokens.some((token) => unambiguousPrefixPair(token, needle));
  });
  const uniquePrefix = uniquePreserve(prefixHits);
  if (uniquePrefix.length === 1) {
    return { kind: 'hit', value: uniquePrefix[0] };
  }
  if (uniquePrefix.length > 1) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'miss' };
}

function matchRange(userText: string, min?: number, max?: number): ResolverOutcome {
  const inRange = uniqueNumbers(
    extractNumbers(userText).filter((n) => (min === undefined || n >= min) && (max === undefined || n <= max)),
  );
  if (inRange.length === 1) {
    return { kind: 'hit', value: inRange[0] };
  }
  if (inRange.length > 1) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'miss' };
}

function matchJsonPath(path: string, state: FlowState): ResolverOutcome {
  const value = resolveScopePath(path, {
    input: state[FLOW_INPUT_KEY],
    state,
  });
  if (!fieldPopulated(value)) {
    return { kind: 'miss' };
  }
  return { kind: 'hit', value };
}

function tokenize(text: string): string[] {
  return text
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function unambiguousPrefixPair(token: string, value: string): boolean {
  if (token === value) {
    return false;
  }
  const shorter = token.length <= value.length ? token : value;
  const longer = token.length <= value.length ? value : token;
  if (shorter.length < 3) {
    return false;
  }
  return longer.startsWith(shorter);
}

const NUMBER_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;

export function extractNumbers(text: string): number[] {
  const matches = text.match(NUMBER_RE);
  if (!matches) {
    return [];
  }
  const numbers: number[] = [];
  for (const raw of matches) {
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n)) {
      numbers.push(n);
    }
  }
  return numbers;
}

function uniquePreserve(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqueNumbers(values: number[]): number[] {
  const out: number[] = [];
  for (const n of values) {
    if (!out.some((existing) => existing === n)) {
      out.push(n);
    }
  }
  return out;
}

function fieldPopulated(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return false;
  }
  return true;
}
