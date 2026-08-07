import type { AgentConfig } from '../../types/agentConfig.js';
import type { Session } from '../../types/session.js';
import type { AnyTool } from '../../types/effectTool.js';
import type { ExtractedValueStore } from '../../memory/extract/store.js';
import type { ExtractorRuntimeContext, ResolvedExtractor } from '../../memory/extract/types.js';
import type { MemoryBlockScope } from '../../memory/blocks/types.js';
import { resolveExtractor } from '../../memory/extract/defineExtractor.js';
import { buildSearchMemoryTool } from '../../memory/extract/searchMemoryTool.js';
import { isValidOwner } from '../../memory/blocks/ownerKey.js';
import { wrapAiSdkTool } from '../../tools/effect/wrapAiSdkTool.js';
import { resolveWorkingMemoryOwner } from './workingMemory.js';
// Same warning `wireWorkingMemory` uses, so a missing userId reports once per
// session across every memory surface rather than once per surface.
import { warnMissingUserId } from './memory.js';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wires the `search_memory` tool for one turn, or withholds it entirely.
 *
 * Two independent reasons withhold the tool, both "absent" rather than
 * "present but broken" — a search tool that silently returns nothing is worse
 * than one that is not offered at all:
 *
 *  - No declared extractor is addressable in this session (no owner — see
 *    `resolveWorkingMemoryOwner`). Mirrors `wireWorkingMemory` exactly.
 *  - The agent declares no extractors at all. `z.enum([])` is not
 *    constructible, so there is no schema to build.
 */
export async function wireSearchMemory(
  agent: AgentConfig,
  session: Session,
  store: ExtractedValueStore,
): Promise<AnyTool | undefined> {
  const declared = agent.memory?.extract ?? [];
  if (declared.length === 0) {
    return undefined;
  }

  const resolveOwner = (scope: MemoryBlockScope): string | undefined => {
    const owner = resolveWorkingMemoryOwner(scope, agent.id, session.userId);
    // An owner outside the allow-list is unusable, not merely awkward — treat
    // it exactly as an unresolvable owner, same as `wireWorkingMemory`.
    return owner !== undefined && isValidOwner(owner) ? owner : undefined;
  };

  const addressable = declared.filter((extractor) => resolveOwner(extractor.scope) !== undefined);
  if (addressable.length === 0) {
    if (
      declared.some(
        (extractor) => resolveWorkingMemoryOwner(extractor.scope, agent.id, session.userId) === undefined,
      )
    ) {
      warnMissingUserId(session.id);
    }
    return undefined;
  }

  const ctx: ExtractorRuntimeContext = {
    agentId: agent.id,
    sessionId: session.id,
    userId: session.userId,
  };

  const resolved: ResolvedExtractor<never>[] = [];
  for (const extractor of addressable) {
    try {
      resolved.push(await resolveExtractor(extractor, ctx));
    } catch (err) {
      console.warn(
        `[Kuralle] search_memory: extractor "${extractor.name}" failed to resolve and was ` +
          `withheld from this turn: ${describeError(err)}`,
      );
    }
  }
  if (resolved.length === 0) {
    return undefined;
  }

  return wrapAiSdkTool(
    'search_memory',
    buildSearchMemoryTool({ store, extractors: resolved, resolveOwner }),
  );
}
