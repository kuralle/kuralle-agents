import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ConversationOutcome, ConversationOutcomeRecord } from './types.js';

export const OUTCOMES_MARK_TOOL_NAME = 'outcomes_mark';

const markOutcomeInput = z.object({
  outcome: z.enum(['resolved', 'unresolved', 'escalated', 'abandoned']),
  reason: z.string().optional(),
});

export interface MarkOutcomeToolResult {
  type: 'conversation-outcome';
  outcome: ConversationOutcome;
  reason?: string;
  markedAt: string;
  markedBy: ConversationOutcomeRecord['markedBy'];
}

export function buildMarkOutcomeTool(
  markOutcome: (
    outcome: ConversationOutcome,
    opts?: { reason?: string },
  ) => Promise<ConversationOutcomeRecord>,
): ToolSet[string] {
  return tool({
    description: 'Mark the conversation outcome when the customer resolution state is clear.',
    inputSchema: markOutcomeInput,
    execute: async (input): Promise<MarkOutcomeToolResult> => {
      const parsed = markOutcomeInput.parse(input);
      const record = await markOutcome(parsed.outcome, parsed.reason ? { reason: parsed.reason } : undefined);
      return {
        type: 'conversation-outcome',
        outcome: record.outcome,
        ...(record.reason ? { reason: record.reason } : {}),
        markedAt: record.markedAt,
        markedBy: record.markedBy,
      };
    },
  }) as ToolSet[string];
}

