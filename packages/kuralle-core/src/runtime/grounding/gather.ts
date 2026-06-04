import type { SourceRef } from '../../types/voice.js';
import type { GatherScope, RunContext } from '../../types/run-context.js';

export type { GatherScope } from '../../types/run-context.js';

export interface GatherResult {
  retrievalBlock?: string;
  memoryBlock?: string;
  citations?: SourceRef[];
}

function normalizeRetrieveResult(
  raw: string | { block?: string; citations?: SourceRef[] } | undefined,
): { retrievalBlock?: string; citations?: SourceRef[] } {
  if (raw == null) {
    return {};
  }
  if (typeof raw === 'string') {
    return { retrievalBlock: raw };
  }
  return { retrievalBlock: raw.block, citations: raw.citations };
}

export async function runGatherPhase(ctx: RunContext, scope?: GatherScope): Promise<GatherResult> {
  let retrievalBlock: string | undefined;
  let citations: SourceRef[] | undefined;

  if (ctx.autoRetrieve && scope?.knowledge?.autoRetrieve !== false) {
    const raw = await ctx.autoRetrieve.retrieve(ctx, scope);
    const normalized = normalizeRetrieveResult(raw);
    retrievalBlock = normalized.retrievalBlock;
    citations = normalized.citations;
    ctx.lastRetrievalCitations = citations;
  } else {
    ctx.lastRetrievalCitations = undefined;
  }

  const memoryBlock =
    ctx.memoryService?.preload && scope?.memory?.preload !== false
      ? await ctx.memoryService.preload(ctx, scope)
      : undefined;
  return { retrievalBlock, memoryBlock, citations };
}
