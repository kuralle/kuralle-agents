import type { ToolSet } from 'ai';
import type { ResolvedNode } from '../../types/channel.js';
import type { NodeToolScope } from '../../types/flow.js';
import type { AnyTool } from '../../types/effectTool.js';
import type { RunContext } from '../../types/run-context.js';
import { buildToolSet } from '../../tools/effect/index.js';
import { isFlowTransitionControlTool } from '../../flow/flowControlTools.js';

export type ResolveNodeToolsContext = Pick<
  RunContext,
  'globalTools' | 'workingMemoryTools' | 'outOfBandControl'
>;

/**
 * Compose the model-visible tool set for a resolved reply/extraction node.
 *
 * Driven by `resolved.toolScope` (default `'open'`). Flow-transition control
 * tools are filtered only by `siloFlowControl` (`outOfBandControl &&
 * !freeConversation`), independent of scope.
 *
 * Precedence on name collision matches the prior inclusive union: node
 * `resolved.tools` wins; among the other layers, later entries win
 * (`localTools` over working-memory over `globalTools` over agent tools).
 */
export function resolveNodeTools(
  resolved: ResolvedNode,
  ctx: ResolveNodeToolsContext,
  agentToolDefs: Record<string, AnyTool> = {},
): ToolSet | undefined {
  const scope: NodeToolScope = resolved.toolScope ?? 'open';
  const siloFlowControl = Boolean(ctx.outOfBandControl && !resolved.freeConversation);

  const merged: Record<string, AnyTool> = {
    ...(scope === 'open' ? agentToolDefs : {}),
    ...(scope !== 'closed' ? (ctx.globalTools ?? {}) : {}),
    ...(scope !== 'closed' ? (ctx.workingMemoryTools ?? {}) : {}),
    ...(resolved.localTools ?? {}),
  };

  const aiTools: ToolSet = { ...resolved.tools };
  for (const [name, tool] of Object.entries(merged)) {
    if (siloFlowControl && isFlowTransitionControlTool(name)) {
      continue;
    }
    if (tool && !aiTools[name]) {
      Object.assign(aiTools, buildToolSet({ [name]: tool }));
    }
  }

  if (siloFlowControl) {
    for (const name of Object.keys(aiTools)) {
      if (isFlowTransitionControlTool(name)) {
        delete aiTools[name];
      }
    }
  }

  if (Object.keys(aiTools).length === 0 && Object.keys(merged).length === 0) {
    return undefined;
  }
  if (Object.keys(aiTools).length === 0) {
    const filteredMerged = siloFlowControl
      ? Object.fromEntries(
          Object.entries(merged).filter(([name]) => !isFlowTransitionControlTool(name)),
        )
      : merged;
    if (Object.keys(filteredMerged).length === 0) {
      return undefined;
    }
    return buildToolSet(filteredMerged);
  }
  return aiTools;
}
