import type { AgentConfig } from '../../types/agentConfig.js';
import type { MemoryService, RunContext } from '../../types/run-context.js';
import type { ExtractedValueStore } from '../../memory/extract/store.js';
import { preloadMemoryContext } from '../../memory/preloadMemory.js';
import { isValidOwner } from '../../memory/blocks/ownerKey.js';

const warnedSessions = new Set<string>();

function latestUserMessage(ctx: RunContext): string {
  for (let index = ctx.runState.messages.length - 1; index >= 0; index -= 1) {
    const message = ctx.runState.messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

export function warnMissingUserId(sessionId: string): void {
  if (warnedSessions.has(sessionId)) {
    return;
  }
  warnedSessions.add(sessionId);
  console.warn(
    '[Kuralle] memory is configured but this session has no userId. ' +
      'User-scoped memory is unavailable for it — preload and working-memory ' +
      'blocks are all skipped rather than shared with other userless sessions. ' +
      'Pass userId via run({ userId }).',
  );
}

export function resetMissingUserIdWarningsForTests(): void {
  warnedSessions.clear();
}

export function buildMemoryService(
  agent: AgentConfig,
  extractedValueStore: ExtractedValueStore,
): MemoryService | undefined {
  if (!agent.memory) {
    return undefined;
  }

  const preloadEnabled = agent.memory.preload?.enabled === true;
  if (!preloadEnabled) {
    return undefined;
  }

  return {
    preload: async (ctx, scope) => {
      if (!ctx.session.userId) {
        warnMissingUserId(ctx.session.id);
        return undefined;
      }
      // Symmetry with the write side. `runExtractors` refuses to write a row for
      // an owner outside the allow-list, so reading one would only ever surface
      // rows written before this guard existed — under a key we have since
      // stopped considering addressable. Refuse both directions or neither.
      if (!isValidOwner(ctx.session.userId)) {
        return undefined;
      }
      const userInput = scope?.query ?? latestUserMessage(ctx);
      if (!userInput.trim()) {
        return undefined;
      }
      const budget = scope?.memory?.tokenBudget ?? agent.memory?.preload?.tokenBudget ?? 500;
      const block = await preloadMemoryContext(extractedValueStore, ctx.session, userInput, budget);
      return block ? `\n\n${block}` : undefined;
    },
  };
}
