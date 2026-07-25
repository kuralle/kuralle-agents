import type { ConversationOutcome } from '../outcomes/types.js';
import type { ChoiceOption } from './selection.js';
import type { EscalationReason } from '../escalation/types.js';

export type StreamChannel = 'client' | 'internal';

export interface StreamPartBase<Channel extends StreamChannel = StreamChannel> {
  channel: Channel;
}

export interface TextStartPayload {
  id: string;
}

export interface TextDeltaPayload {
  id: string;
  delta: string;
}

export interface TextEndPayload {
  id: string;
}

export interface TextCancelPayload {
  id: string;
  reason: string;
}

export interface ToolCallPayload {
  toolName: string;
  args: unknown;
  toolCallId?: string;
}

export interface ToolResultPayload {
  toolName: string;
  result: unknown;
  toolCallId?: string;
}

export interface FlowEnterPayload {
  flow: string;
}

export interface FlowEndPayload {
  flow: string;
  reason: string;
}

export interface NodeEnterPayload {
  nodeName: string;
}

export interface NodeExitPayload {
  nodeName: string;
}

export interface FlowTransitionPayload {
  from: string;
  to: string;
}

export interface HandoffPayload {
  targetAgent: string;
  reason?: string;
}

export interface InterruptedPayload {
  reason: string;
  lastStep: number;
}

export interface PausedPayload {
  waitingFor: string;
}

export interface ConversationOutcomePayload {
  outcome: ConversationOutcome;
}

export interface InteractivePayload {
  nodeId: string;
  options: ChoiceOption[];
  prompt: string;
}

export interface TurnEndPayload {}

export interface PipelineValidationBlockPayload {
  rationale: string;
  userFacingMessage?: string;
}

export interface SafetyBlockedPayload {
  moderator: string;
  rationale: string;
  userFacingMessage: string;
  handlerOutcome?: 'queued' | 'connected' | 'failed';
}

export interface WakePayload {
  reason: string;
}

export interface EscalationPayload {
  reason: string;
  category?: EscalationReason;
  outcome: 'queued' | 'connected' | 'failed';
  summary?: string;
}

export interface ContextCompactedPayload {
  beforeTokens: number;
  afterTokens: number;
  summarizedCount: number;
}

export interface CompactionSkippedPayload {
  reason: string;
}

export interface ContextOverflowRecoveredPayload {
  strippedCount: number;
  compacted: boolean;
}

export interface ErrorPayload {
  error: string;
}

export interface CustomPayload {
  name: string;
  data: unknown;
}

export interface DonePayload {
  sessionId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
  };
}

export interface KnowledgeCacheHitPayload {
  query: string;
  resultCount: number;
  latencyMs: number;
}

export interface KnowledgeCacheMissPayload {
  query: string;
  latencyMs: number;
}

export interface KnowledgeSearchPayload {
  query: string;
  resultCount: number;
  latencyMs: number;
  layer: 'cache' | 'hybrid';
}

export interface KnowledgeQualityCheckPayload {
  query: string;
  quality: 'high' | 'medium' | 'low';
  topScore: number;
  avgScore: number;
  coverageEstimate: number;
}

export interface KnowledgeReformulationPayload {
  originalQuery: string;
  reformulatedQuery: string;
  trigger: 'inline' | 'background';
  latencyMs: number;
}

interface StreamPayloadMap {
  'text-start': TextStartPayload;
  'text-delta': TextDeltaPayload;
  'text-end': TextEndPayload;
  'text-cancel': TextCancelPayload;
  'tool-call': ToolCallPayload;
  'tool-result': ToolResultPayload;
  'flow-enter': FlowEnterPayload;
  'flow-end': FlowEndPayload;
  'node-enter': NodeEnterPayload;
  'node-exit': NodeExitPayload;
  'flow-transition': FlowTransitionPayload;
  handoff: HandoffPayload;
  interrupted: InterruptedPayload;
  paused: PausedPayload;
  'conversation-outcome': ConversationOutcomePayload;
  interactive: InteractivePayload;
  'turn-end': TurnEndPayload;
  'pipeline-validation-block': PipelineValidationBlockPayload;
  'safety-blocked': SafetyBlockedPayload;
  wake: WakePayload;
  escalation: EscalationPayload;
  'context-compacted': ContextCompactedPayload;
  'compaction-skipped': CompactionSkippedPayload;
  'context-overflow-recovered': ContextOverflowRecoveredPayload;
  error: ErrorPayload;
  custom: CustomPayload;
  done: DonePayload;
  'knowledge-cache-hit': KnowledgeCacheHitPayload;
  'knowledge-cache-miss': KnowledgeCacheMissPayload;
  'knowledge-search': KnowledgeSearchPayload;
  'knowledge-quality-check': KnowledgeQualityCheckPayload;
  'knowledge-reformulation': KnowledgeReformulationPayload;
}

type ClientStreamPartType =
  | 'text-start'
  | 'text-delta'
  | 'text-end'
  | 'text-cancel'
  | 'conversation-outcome'
  | 'error'
  | 'done';

type ChannelFor<Type extends keyof StreamPayloadMap> =
  Type extends ClientStreamPartType ? 'client' : 'internal';

export type StreamPart = {
  [Type in keyof StreamPayloadMap]: StreamPartBase<ChannelFor<Type>> & {
    type: Type;
    payload: StreamPayloadMap[Type];
  };
}[keyof StreamPayloadMap];

export const PART_CHANNEL: Record<StreamPart['type'], StreamChannel> = {
  'text-start': 'client',
  'text-delta': 'client',
  'text-end': 'client',
  'text-cancel': 'client',
  'tool-call': 'internal',
  'tool-result': 'internal',
  'flow-enter': 'internal',
  'flow-end': 'internal',
  'node-enter': 'internal',
  'node-exit': 'internal',
  'flow-transition': 'internal',
  handoff: 'internal',
  interrupted: 'internal',
  paused: 'internal',
  'conversation-outcome': 'client',
  interactive: 'internal',
  'turn-end': 'internal',
  'pipeline-validation-block': 'internal',
  'safety-blocked': 'internal',
  wake: 'internal',
  escalation: 'internal',
  'context-compacted': 'internal',
  'compaction-skipped': 'internal',
  'context-overflow-recovered': 'internal',
  error: 'client',
  custom: 'internal',
  done: 'client',
  'knowledge-cache-hit': 'internal',
  'knowledge-cache-miss': 'internal',
  'knowledge-search': 'internal',
  'knowledge-quality-check': 'internal',
  'knowledge-reformulation': 'internal',
};

export interface TurnHandle extends Promise<import('./channel.js').TurnResult> {
  readonly events: AsyncIterable<StreamPart>;
  toResponseStream(format?: 'sse' | 'ndjson'): ReadableStream;
  toUIMessageStreamResponse(opts?: { sessionId?: string }): Response;
  cancel(reason?: string): void;
}
