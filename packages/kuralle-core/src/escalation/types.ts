export type EscalationReason = 'low-confidence' | 'user-request' | 'frustration' | 'tool-call' | 'safety-block';

export type EscalationOutcome =
  | { status: 'queued'; queueId: string; estimatedWaitSec?: number }
  | { status: 'connected'; operatorId: string }
  | { status: 'failed'; error: string };
