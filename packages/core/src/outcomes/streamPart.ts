import type { StreamPart } from '../types/stream.js';
import type { ConversationOutcomeRecord } from './types.js';

export function toConversationOutcomeStreamPart(record: ConversationOutcomeRecord): StreamPart {
  return {
    channel: 'client',
    type: 'conversation-outcome',
    payload: { outcome: record.outcome },
  };
}
