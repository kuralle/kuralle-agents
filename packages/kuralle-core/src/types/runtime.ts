import type { ModelMessage } from 'ai';
import type { SessionEndMetadata, TurnUsage } from './telemetry.js';
import type { AgentStreamPart } from './processors.js';
import type { AgentContext, RunContext, Session, ToolCallRecord } from './session.js';
import type { HarnessStreamPart } from './voice.js';
import type { RefineDecision, ValidateDecision } from '../capabilities/index.js';
import type { ConversationOutcome, ConversationOutcomeRecord } from '../outcomes/types.js';
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
  onStreamPart?: (ctx: AgentContext, part: AgentStreamPart) => Promise<void>;
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

export interface StepResult {
  text?: string;
  toolCalls: ToolCallRecord[];
  finishReason: string;
  tokensUsed: number;
  handoffTo?: string;
}

export interface TurnSummary {
  sessionId: string;
  userId?: string;
  agentId: string;
  messageCount: number;
  toolCallCount: number;
  totalTokens: number;
}

export interface TurnEndHookResult {
  outcome?: ConversationOutcome;
  reason?: string;
}

export interface HarnessHooks {
  onStart?: (context: RunContext) => Promise<void>;
  onEnd?: (context: RunContext, result: { success: boolean; error?: Error }) => Promise<void>;
  onStepStart?: (context: RunContext, step: number) => Promise<void>;
  onStepEnd?: (context: RunContext, step: number, result: StepResult) => Promise<void>;
  onToolCall?: (context: RunContext, call: ToolCallRecord) => Promise<void>;
  onToolResult?: (context: RunContext, call: ToolCallRecord) => Promise<void>;
  onToolError?: (context: RunContext, call: ToolCallRecord, error: Error) => Promise<void>;
  onTurnEnd?: (context: RunContext, summary: TurnSummary) => Promise<TurnEndHookResult | void>;
  onAgentStart?: (context: RunContext, agentId: string) => Promise<void>;
  onAgentEnd?: (context: RunContext, agentId: string) => Promise<void>;
  onHandoff?: (context: RunContext, from: string, to: string, reason: string) => Promise<void>;
  onError?: (context: RunContext, error: Error) => Promise<void>;
  onMessage?: (context: RunContext, message: ModelMessage) => Promise<void>;
  onStreamPart?: (context: RunContext, part: HarnessStreamPart) => Promise<void>;
  onPersistenceError?: (session: Session, error: Error) => Promise<void>;
  onMemoryIngest?: (context: RunContext, session: Session) => Promise<boolean | void>;
  onMemoryIngested?: (context: RunContext, session: Session) => Promise<void>;
  onBeforeModelCall?: (context: RunContext, data: BeforeModelCallData) => Promise<BeforeModelCallResult | void>;
  onSessionEnd?: (session: Session, metadata: SessionEndMetadata) => Promise<void>;
  onConversationEnd?: (
    session: Session,
    outcome: ConversationOutcomeRecord,
  ) => Promise<{ csatInvited: boolean; csatChannel?: 'email' | 'in-app' | 'sms' } | void>;
  onTokensUpdate?: (context: RunContext, turn: TurnUsage) => Promise<void> | void;
}

export interface BeforeModelCallData {
  systemPrompt: string;
  messages: ModelMessage[];
  estimatedTokens: number;
  agentId: string;
  tokenBreakdown: {
    basePrompt: number;
    autoRetrieve: number;
    workingMemory: number;
    extraction: number;
    longTermMemory: number;
    policyInjections: number;
    messageHistory: number;
  };
}

export interface BeforeModelCallResult {
  systemPrompt?: string;
  messages?: ModelMessage[];
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
