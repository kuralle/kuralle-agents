import type { RunContext } from '../../types/run-context.js';

export interface GatherResult {
  retrievalBlock?: string;
  memoryBlock?: string;
}

export async function runGatherPhase(ctx: RunContext): Promise<GatherResult> {
  const retrievalBlock = ctx.autoRetrieve ? await ctx.autoRetrieve.retrieve(ctx) : undefined;
  const memoryBlock = ctx.memoryService?.preload ? await ctx.memoryService.preload(ctx) : undefined;
  return { retrievalBlock, memoryBlock };
}
