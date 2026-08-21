import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { estimateTokenCount } from './ContextBudget.js';

/**
 * Automatic conversation-history compaction.
 *
 * Long-running sessions (weeks-long WhatsApp threads) grow unbounded; budget
 * truncation silently loses the early relationship. Compaction summarizes the
 * older history into one system note and keeps the recent tail verbatim, so
 * the model retains facts/decisions without paying the full token cost.
 *
 * Runs post-turn (off the user's latency path) when the estimated history
 * tokens exceed `triggerTokens`, and force-runs as the recovery step after a
 * provider context-overflow error (see `contextOverflow.ts`).
 */
export interface CompactionConfig {
  /** Summarizer model. Defaults to the active agent's controlModel/model. */
  model?: LanguageModel;
  /** Estimated history tokens that trigger compaction. Default: 8000. */
  triggerTokens?: number;
  /** Number of recent messages kept verbatim. Default: 12. */
  keepRecentMessages?: number;
  /** Override the summarizer system prompt. */
  summaryPrompt?: string;
}

export const DEFAULT_COMPACTION_TRIGGER_TOKENS = 8_000;
export const DEFAULT_COMPACTION_KEEP_RECENT = 12;

const DEFAULT_SUMMARY_PROMPT = [
  'Summarize this conversation so an assistant can continue it seamlessly.',
  'Preserve, with exact values: user identity details shared (name, address, contact),',
  'stable preferences, decisions made, actions COMPLETED (orders, bookings, tool actions',
  'with their result ids/amounts), and open questions or pending steps.',
  'Do not invent anything. Maximum 250 words.',
].join(' ');

export type CompactionResult =
  | {
      compacted: true;
      /** Verbatim retained tail — never includes a compaction summary message. */
      messages: ModelMessage[];
      /** Summary text for the system-note channel (`addSystemNote`, lifetime `run`). */
      summary: string;
      beforeTokens: number;
      afterTokens: number;
      summarizedCount: number;
    }
  | { compacted: false; reason: 'under-threshold' | 'too-few-messages' | 'summarizer-error'; beforeTokens: number };

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokenCount(
      typeof message.content === 'string' ? message.content : safeStringify(message.content),
    );
  }
  return total;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Text projection of messages for the summarizer (tool calls become bracketed notes). */
function renderTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      lines.push(`${message.role}: ${message.content}`);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    const parts: string[] = [];
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      } else if (part.type === 'tool-call') {
        parts.push(`[called ${String(part.toolName)} with ${truncate(safeStringify(part.input ?? part.args), 200)}]`);
      } else if (part.type === 'tool-result') {
        parts.push(`[${String(part.toolName)} returned ${truncate(safeStringify(part.output ?? part.result), 200)}]`);
      } else if (part.type === 'file' || part.type === 'image') {
        parts.push(`[${String(part.type)} attachment]`);
      }
    }
    if (parts.length > 0) {
      lines.push(`${message.role}: ${parts.join(' ')}`);
    }
  }
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface CompactMessagesOptions {
  messages: ModelMessage[];
  model: LanguageModel;
  config: CompactionConfig;
  /** Skip the threshold check (overflow recovery). */
  force?: boolean;
  abortSignal?: AbortSignal;
  /** Real last-turn prompt tokens when available (replaces chars/4 for threshold). */
  lastPromptTokens?: number;
  /** Prior compaction summary — folded into the summarizer input so facts chain across rounds. */
  priorSummary?: string;
}

/**
 * Pure compaction step: returns a new message list when compaction applied.
 * The kept tail always starts at a `user` message so assistant/tool-call
 * pairs are never split across the summary boundary.
 */
export async function compactMessages(options: CompactMessagesOptions): Promise<CompactionResult> {
  const { messages, model, config, force, abortSignal, lastPromptTokens, priorSummary } = options;
  const triggerTokens = config.triggerTokens ?? DEFAULT_COMPACTION_TRIGGER_TOKENS;
  const keepRecent = config.keepRecentMessages ?? DEFAULT_COMPACTION_KEEP_RECENT;

  const estimatedTokens = estimateMessagesTokens(messages);
  const beforeTokens = lastPromptTokens ?? estimatedTokens;
  if (!force && beforeTokens < triggerTokens) {
    return { compacted: false, reason: 'under-threshold', beforeTokens };
  }

  let cut = Math.max(messages.length - keepRecent, 0);
  while (cut > 0 && messages[cut]?.role !== 'user') {
    cut -= 1;
  }
  if (cut < 2) {
    return { compacted: false, reason: 'too-few-messages', beforeTokens };
  }

  const older = messages.slice(0, cut);
  const newerTranscript = renderTranscript(older);
  const prompt = priorSummary
    ? [
        'The transcript below begins with a summary of even earlier conversation, followed by newer turns.',
        'Produce one consolidated summary that preserves all facts from the previous summary and the newer turns.',
        '',
        'Previous conversation summary:',
        priorSummary,
        '',
        'Newer turns since that summary:',
        newerTranscript,
      ].join('\n')
    : newerTranscript;

  let summary: string;
  try {
    const result = await generateText({
      model,
      system: config.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
      prompt,
      abortSignal,
    });
    summary = result.text.trim();
    if (!summary) {
      return { compacted: false, reason: 'summarizer-error', beforeTokens };
    }
  } catch {
    return { compacted: false, reason: 'summarizer-error', beforeTokens };
  }

  const retained = messages.slice(cut);

  return {
    compacted: true,
    messages: retained,
    summary: `[Conversation summary — earlier turns were compacted]\n${summary}`,
    beforeTokens,
    afterTokens: estimateMessagesTokens(retained),
    summarizedCount: older.length,
  };
}
