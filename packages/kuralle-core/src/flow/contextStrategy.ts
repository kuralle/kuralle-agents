import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { ContextStrategy } from '../types/context.js';
import type { Flow } from '../types/flow.js';
import type { RunState } from '../runtime/durable/types.js';

export interface ApplyContextStrategyOptions {
  strategy: ContextStrategy;
  run: RunState;
  flow: Flow;
  model: LanguageModel;
  summaryPrompt?: string;
  abortSignal?: AbortSignal;
}

function isSystemMessage(message: ModelMessage): boolean {
  return message.role === 'system';
}

function trimToSystemAndLastUser(messages: ModelMessage[]): ModelMessage[] {
  const system = messages.filter(isSystemMessage);
  let lastUser: ModelMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      lastUser = message;
      break;
    }
  }
  return lastUser ? [...system, lastUser] : system;
}

async function summarizeMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) {
    return null;
  }
  try {
    const result = await generateText({
      model,
      system: prompt,
      messages,
      abortSignal,
    });
    return result.text.trim() || null;
  } catch {
    return null;
  }
}

export async function applyContextStrategy(options: ApplyContextStrategyOptions): Promise<void> {
  const { strategy, run, flow, model, abortSignal } = options;
  const summaryPrompt =
    options.summaryPrompt ??
    'Summarize the key points from this conversation in 2-3 sentences.';

  switch (strategy) {
    case 'reset':
      run.messages = trimToSystemAndLastUser(run.messages);
      break;
    case 'reset_with_summary': {
      if (run.messages.length === 0) {
        break;
      }
      const summary = await summarizeMessages(run.messages, model, summaryPrompt, abortSignal);
      if (summary) {
        run.messages = [{ role: 'system', content: `Previous conversation summary: ${summary}` }];
      } else {
        run.messages = trimToSystemAndLastUser(run.messages);
      }
      break;
    }
    case 'append':
    default:
      break;
  }

  if (flow.context === strategy) {
    run.updatedAt = Date.now();
  }
}

export function resolveContextStrategy(
  nodeContext: ContextStrategy | undefined,
  flow: Flow,
): ContextStrategy {
  return nodeContext ?? flow.context ?? 'append';
}
