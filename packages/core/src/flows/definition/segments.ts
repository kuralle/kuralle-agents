import type { Flow } from '../../types/flow.js';
import { readStashedFlowDefinition } from './storable.js';
import type { FlowDefinition, FlowNodeDefinition, TransitionRef } from './types.js';

/** Consecutive eligible nodes in one batched run. Longer chains split. */
export const MAX_SEGMENT_LENGTH = 8;

/** Maximal chains per flow. Further eligible runs stay on the per-node path. */
export const MAX_SEGMENTS = 32;

export type SegmentKind = 'generate-replies' | 'actions';

export interface FlowSegment {
  readonly nodeIds: readonly string[];
  readonly kind: SegmentKind;
}

const liveFlowSegmentCache = new WeakMap<Flow, ReadonlyMap<string, FlowSegment>>();
const EMPTY_SEGMENTS: ReadonlyMap<string, FlowSegment> = new Map();

/**
 * Unconditional successor used to *grow* a segment. `data` injects state, so it
 * is a boundary — the source node may still be the last member of a chain.
 */
function unconditionalGoto(next: TransitionRef | undefined): string | undefined {
  if (next === undefined || next === 'stay') return undefined;
  if (!('goto' in next)) return undefined;
  if (next.data !== undefined) return undefined;
  return next.goto;
}

function hasInterpolation(text: string | undefined): boolean {
  return typeof text === 'string' && text.includes('${');
}

/**
 * Conservative eligibility. When in doubt, exclude — a missed batch degrades to
 * today's per-node path; a false include skips semantics.
 *
 * Interpolating generate instructions close over `state`/`results` that a prior
 * action in a mixed chain would have written. Combining prompts at segment start
 * would freeze stale scope, so those replies are never eligible.
 */
function eligibility(def: FlowNodeDefinition): SegmentKind | undefined {
  if (def.kind === 'action') {
    if (def.approval) return undefined;
    if (def.routes && def.routes.length > 0) return undefined;
    return 'actions';
  }
  if (def.kind === 'reply') {
    if (!('generate' in def) || def.generate !== true) return undefined;
    if ('response' in def) return undefined;
    if (def.routes && def.routes.length > 0) return undefined;
    if (hasInterpolation(def.instructions)) return undefined;
    return 'generate-replies';
  }
  return undefined;
}

function growFrom(
  start: FlowNodeDefinition,
  kind: SegmentKind,
  byId: Map<string, FlowNodeDefinition>,
): string[] {
  const chain = [start.id];
  const seen = new Set<string>([start.id]);
  while (chain.length < MAX_SEGMENT_LENGTH) {
    const last = byId.get(chain[chain.length - 1]!);
    if (!last || (last.kind !== 'action' && last.kind !== 'reply')) break;
    const nextId = unconditionalGoto(last.next);
    if (!nextId) break;
    const next = byId.get(nextId);
    if (!next) break;
    if (eligibility(next) !== kind) break;
    if (seen.has(nextId)) break;
    seen.add(nextId);
    chain.push(nextId);
  }
  return chain;
}

/** Pure graph analysis. Keys every node that starts a remaining run of length ≥ 2. */
export function computeFlowSegments(def: FlowDefinition): ReadonlyMap<string, FlowSegment> {
  const byId = new Map(def.nodes.map((node) => [node.id, node]));
  const result = new Map<string, FlowSegment>();
  const claimed = new Set<string>();
  let maximal = 0;

  for (const node of def.nodes) {
    if (claimed.has(node.id)) continue;
    const kind = eligibility(node);
    if (!kind) continue;
    const chain = growFrom(node, kind, byId);
    if (chain.length < 2) continue;
    if (maximal >= MAX_SEGMENTS) break;
    maximal += 1;
    for (let i = 0; i < chain.length - 1; i++) {
      result.set(chain[i]!, { nodeIds: chain.slice(i), kind });
    }
    for (const id of chain) claimed.add(id);
  }

  return result;
}

/**
 * Segments for a live Flow. Rehydrated flows hash their stash; code-authored
 * flows cannot prove unconditional `next` without running closures, so they
 * get an empty map (per-node path). Computed once per Flow object.
 */
export function segmentsForLiveFlow(flow: Flow): ReadonlyMap<string, FlowSegment> {
  const cached = liveFlowSegmentCache.get(flow);
  if (cached !== undefined) return cached;
  const stashed = readStashedFlowDefinition(flow);
  const computed = stashed ? computeFlowSegments(stashed) : EMPTY_SEGMENTS;
  liveFlowSegmentCache.set(flow, computed);
  return computed;
}

export function segmentStartingAt(flow: Flow, nodeId: string): FlowSegment | undefined {
  return segmentsForLiveFlow(flow).get(nodeId);
}
