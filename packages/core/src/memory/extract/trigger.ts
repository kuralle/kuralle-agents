import type { ModelMessage } from 'ai';
import type { AgentMemory, ExtractionConfig, ExtractionTrigger } from '../../types/grounding.js';
import type { RunState } from '../../runtime/durable/types.js';
import { estimateMessagesTokens } from '../../runtime/compaction.js';

export type { ExtractionConfig, ExtractionTrigger } from '../../types/grounding.js';

export const DEFAULT_EXTRACTION_TRIGGER: ExtractionTrigger = { tokens: 2000 };

export function resolveExtractionConfig(memory: AgentMemory | undefined): ExtractionConfig | undefined {
  if (!memory?.extract?.length) {
    return undefined;
  }
  return {
    trigger: memory.extraction?.trigger ?? DEFAULT_EXTRACTION_TRIGGER,
    blocking: memory.extraction?.blocking ?? false,
  };
}

export function detectTurnHadToolCalls(
  messages: ModelMessage[],
  sinceMessageIndex: number,
): boolean {
  for (const message of messages.slice(sinceMessageIndex)) {
    if (message.role === 'tool') {
      return true;
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          part.type === 'tool-call'
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function shouldExtract(
  runState: RunState,
  trigger: ExtractionTrigger,
  turnHadToolCalls: boolean,
): boolean {
  if (trigger === 'each-turn') {
    return true;
  }
  if (trigger === 'idle') {
    return !turnHadToolCalls;
  }
  const start = runState.lastExtractedMessageCount ?? 0;
  const unextracted = runState.messages.slice(start);
  return estimateMessagesTokens(unextracted) >= trigger.tokens;
}
