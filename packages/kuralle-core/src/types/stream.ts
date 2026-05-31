import type { ConversationOutcome } from '../outcomes/types.js';

export type HarnessStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; args: unknown; toolCallId?: string }
  | { type: 'tool-result'; toolName: string; result: unknown; toolCallId?: string }
  | { type: 'flow-enter'; flow: string }
  | { type: 'flow-end'; flow: string; reason: string }
  | { type: 'node-enter'; nodeName: string }
  | { type: 'node-exit'; nodeName: string }
  | { type: 'flow-transition'; from: string; to: string }
  | { type: 'handoff'; targetAgent: string; reason?: string }
  | { type: 'interrupted'; reason: string; lastStep: number }
  | { type: 'paused'; waitingFor: string }
  | { type: 'conversation-outcome'; outcome: ConversationOutcome }
  | { type: 'turn-end' }
  | { type: 'error'; error: string }
  | { type: 'done'; sessionId: string };

export interface TurnHandle extends Promise<import('./channel.js').TurnResult> {
  readonly events: AsyncIterable<HarnessStreamPart>;
  toResponseStream(format?: 'sse' | 'ndjson'): ReadableStream;
  cancel(reason?: string): void;
}
