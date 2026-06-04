import type { GatherScope, RunContext } from '../../types/run-context.js';

export type { GatherScope } from '../../types/run-context.js';

export interface GatherResult {
  retrievalBlock?: string;
  memoryBlock?: string;
}

export async function runGatherPhase(ctx: RunContext, scope?: GatherScope): Promise<GatherResult> {
  const retrievalBlock =
    ctx.autoRetrieve && scope?.knowledge?.autoRetrieve !== false
      ? await ctx.autoRetrieve.retrieve(ctx, scope)
      : undefined;
  const memoryBlock =
    ctx.memoryService?.preload && scope?.memory?.preload !== false
      ? await ctx.memoryService.preload(ctx, scope)
      : undefined;
  return { retrievalBlock, memoryBlock };
}
