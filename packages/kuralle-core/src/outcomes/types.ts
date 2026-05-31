export type ConversationOutcome = 'resolved' | 'unresolved' | 'escalated' | 'abandoned';

export type ConversationOutcomeMarkedBy = 'tool' | 'hook' | 'http' | 'auto';

export interface ConversationOutcomeRecord {
  outcome: ConversationOutcome;
  reason?: string;
  markedAt: string;
  markedBy: ConversationOutcomeMarkedBy;
}

export interface CsatRecord {
  score: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  collectedAt: string;
}

