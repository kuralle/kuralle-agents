import type { AgentContext, RunContext } from './session.js';
import type { StreamPart } from './stream.js';
import type { RefineDecision, ValidateDecision } from '../capabilities/index.js';
import type { ChannelId } from './session.js';

export interface RefinementStageResult {
  proceed: boolean;
  finalUserMessage: string;
  overallConfidence: number;
  aggregateDecision: 'continue' | 'rewrite' | 'escalate' | 'block';
  decisions: RefineDecision[];
}

export interface ValidationStageResult {
  proceed: boolean;
  finalAssistantOutput: string;
  overallConfidence: number;
  aggregateDecision: 'continue' | 'rewrite' | 'block';
  decisions: ValidateDecision[];
}

export interface Hook {
  name: string;
  onTurnStart?: (ctx: AgentContext, input: string) => Promise<void>;
  onTurnEnd?: (ctx: AgentContext) => Promise<void>;
  onStreamPart?: (ctx: AgentContext, part: StreamPart) => Promise<void>;
  onAgentSwitch?: (ctx: AgentContext, from: string, to: string) => Promise<void>;
  onError?: (ctx: AgentContext, error: Error) => Promise<void>;
}

export interface StopConditionResult {
  shouldStop: boolean;
  reason?: string;
}

export interface StopCondition {
  name: string;
  check: (context: RunContext) => StopConditionResult;
}

export interface StreamOptions {
  input: string;
  sessionId?: string;
  userId?: string;
  channelId?: ChannelId;
  abortSignal?: AbortSignal;
  agentId?: string;
}

export interface AbortOptions {
  reason?: string;
  immediate?: boolean;
}

export interface InterruptionEvent {
  type: 'interrupted';
  sessionId: string;
  reason: string;
  timestamp: Date;
  lastAgentId?: string;
  lastStep?: number;
}

export type CancellationReason = 'user_interrupt' | 'timeout' | 'shutdown' | 'custom';

export function isAbortSignal(signal: unknown): signal is AbortSignal {
  return signal instanceof AbortSignal || (
    signal !== null &&
    typeof signal === 'object' &&
    'aborted' in signal &&
    'reason' in signal &&
    'addEventListener' in signal
  );
}
