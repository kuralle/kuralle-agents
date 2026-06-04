import type { RunContext } from '../../../types/run-context.js';
import type { ResolvedNode } from '../../../types/channel.js';

export type StreamMode = 'token' | 'sentence' | 'turn';

function nodeHasWholeAnswerGroundingGate(_ctx: RunContext, node: ResolvedNode): boolean {
  return node.node.kind === 'reply' && node.node.confidenceGate != null;
}

export function resolveStreamMode(ctx: RunContext, node: ResolvedNode): StreamMode {
  const grans = [
    ...(ctx.outputProcessors ?? []).map((p) => p.streamGranularity ?? 'turn'),
    ...(ctx.validationPolicies ?? []).map((p) => p.streamGranularity ?? 'turn'),
  ];
  if (nodeHasWholeAnswerGroundingGate(ctx, node)) grans.push('turn');
  if (grans.includes('turn')) return 'turn';
  if (grans.includes('sentence')) return 'sentence';
  return 'token';
}
