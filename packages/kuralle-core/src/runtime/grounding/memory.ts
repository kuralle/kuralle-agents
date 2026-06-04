import type { AgentConfig } from '../../types/agentConfig.js';
import type { MemoryService as V1MemoryService } from '../../memory/MemoryService.js';
import type { MemoryService as MemoryService, RunContext } from '../../types/run-context.js';
import { preloadMemoryContext } from '../../memory/preloadMemory.js';

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
    '[Kuralle] memory is configured but session has no userId. ' +
      'Memory preload/ingest will be skipped. Pass userId via run({ userId }).',
  );
}

export function resetMissingUserIdWarningsForTests(): void {
  warnedSessions.clear();
}

export function buildMemoryService(
  service: V1MemoryService,
  agent: AgentConfig,
): MemoryService | undefined {
  if (!agent.memory) {
    return undefined;
  }

  const preloadEnabled = agent.memory.preload?.enabled === true;
  const ingestEnabled = agent.memory.ingest?.enabled === true;
  if (!preloadEnabled && !ingestEnabled) {
    return undefined;
  }

  return {
    preload: preloadEnabled
      ? async (ctx, scope) => {
          if (!ctx.session.userId) {
            warnMissingUserId(ctx.session.id);
            return undefined;
          }
          const userInput = scope?.query ?? latestUserMessage(ctx);
          if (!userInput.trim()) {
            return undefined;
          }
          const budget = scope?.memory?.tokenBudget ?? agent.memory?.preload?.tokenBudget ?? 500;
          const block = await preloadMemoryContext(service, ctx.session, userInput, budget);
          return block ? `\n\n${block}` : undefined;
        }
      : undefined,
    ingest: ingestEnabled
      ? async (ctx) => {
          if (!ctx.session.userId) {
            warnMissingUserId(ctx.session.id);
            return;
          }
          ctx.session.messages = [...ctx.runState.messages];
          await service.addSessionToMemory(ctx.session);
        }
      : undefined,
  };
}

export async function runMemoryIngest(ctx: RunContext): Promise<void> {
  if (!ctx.memoryService?.ingest) {
    return;
  }
  await ctx.memoryService.ingest(ctx);
}
