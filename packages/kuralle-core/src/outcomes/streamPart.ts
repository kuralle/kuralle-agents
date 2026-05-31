import type { HarnessStreamPart } from '../types/voice.js';
import type { ConversationOutcomeRecord } from './types.js';

export function toConversationOutcomeStreamPart(record: ConversationOutcomeRecord): HarnessStreamPart {
  return {
    type: 'conversation-outcome',
    outcome: record.outcome,
    ...(record.reason ? { reason: record.reason } : {}),
    markedBy: record.markedBy,
  };
}

