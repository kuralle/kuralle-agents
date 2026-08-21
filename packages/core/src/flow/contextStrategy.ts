import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { ContextStrategy } from '../types/context.js';
import type { Flow } from '../types/flow.js';
import type { RunState } from '../runtime/durable/types.js';
import { addSystemNote, readSystemNote } from '../runtime/systemNotes.js';

export interface ApplyContextStrategyOptions {
  strategy: ContextStrategy;
  run: RunState;
  flow: Flow;
  model: LanguageModel;
  summaryPrompt?: string;
  abortSignal?: AbortSignal;
}

function trimToLastUser(messages: ModelMessage[]): ModelMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return [message];
    }
  }
  return [];
}

async function summarizeMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  prompt: string,
  abortSignal?: AbortSignal,
  priorSummary?: string,
): Promise<string | null> {
  if (messages.length === 0 && !priorSummary) {
    return null;
  }
  try {
    const result = await generateText({
      model,
      system: prompt,
      ...(priorSummary
        ? {
            prompt: [
              'The transcript below begins with a summary of even earlier conversation, followed by newer turns.',
              'Produce one consolidated summary that preserves all facts from the previous summary and the newer turns.',
              '',
              'Previous conversation summary:',
              priorSummary,
              '',
              'Newer turns since that summary:',
              messages
                .map((message) =>
                  typeof message.content === 'string'
                    ? `${message.role}: ${message.content}`
                    : `${message.role}: [non-text content]`,
                )
                .join('\n'),
            ].join('\n'),
          }
        : { messages }),
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
      run.messages = trimToLastUser(run.messages);
      break;
    case 'reset_with_summary': {
      if (run.messages.length === 0) {
        break;
      }
      const priorSummary = readSystemNote(run, 'context-reset-summary');
      const summary = await summarizeMessages(
        run.messages,
        model,
        summaryPrompt,
        abortSignal,
        priorSummary,
      );
      if (summary) {
        addSystemNote(run, `Previous conversation summary: ${summary}`, {
          lifetime: 'run',
          tag: 'context-reset-summary',
        });
        run.messages = [];
      } else {
        run.messages = trimToLastUser(run.messages);
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
