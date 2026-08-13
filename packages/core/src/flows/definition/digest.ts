import type { Flow } from '../../types/flow.js';
import type { FlowDefinition } from './types.js';
import { canonicalJson, sha256 } from './canonical.js';
import { readStashedFlowDefinition } from './storable.js';

export async function flowDigest(def: FlowDefinition): Promise<string> {
  return sha256(canonicalJson(def));
}

const liveFlowDigestCache = new WeakMap<Flow, string>();

/**
 * Digest of a live `Flow` for pinning onto a run.
 *
 * Rehydrated flows (`origin: 'definition'`) hash their stashed definition via
 * `flowDigest`. A definition-origin Flow with no stash is corrupted — throw,
 * do not silently fall back. Code-authored flows use the stable marker
 * `code:<flow.name>`: they change only with a deploy, and the digest guard is
 * about STORED redefinition (`addDynamicFlows` replace / catalog publish).
 *
 * sha256 is computed once per Flow object.
 */
export async function digestForLiveFlow(flow: Flow): Promise<string> {
  const cached = liveFlowDigestCache.get(flow);
  if (cached !== undefined) return cached;
  const digest = await computeLiveFlowDigest(flow);
  liveFlowDigestCache.set(flow, digest);
  return digest;
}

async function computeLiveFlowDigest(flow: Flow): Promise<string> {
  if (flow.origin === 'definition') {
    const stashed = readStashedFlowDefinition(flow);
    if (!stashed) {
      throw new Error(
        `Flow "${flow.name}" is origin:definition but has no stashed definition; the Flow object is corrupted.`,
      );
    }
    return flowDigest(stashed);
  }
  return `code:${flow.name}`;
}
