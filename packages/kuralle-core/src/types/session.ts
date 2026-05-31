import type { ModelMessage } from 'ai';
import type { RetrievalCacheAdapter } from './voice.js';
import type { RefinementStageResult } from './runtime.js';
import type { EscalationReason, EscalationOutcome } from '../escalation/types.js';
import type { ConversationOutcomeRecord, CsatRecord } from '../outcomes/types.js';
import type { PersonaExperimentMetadata } from '../persona/types.js';
import type { ConversationAuditEntry } from '../audit/types.js';

export type ChannelId = 'web' | 'email' | 'sms' | 'voice' | 'api' | 'slack' | 'discord' | (string & {});

// ============================================
// WORKING MEMORY / AGENT CONTEXT
// ============================================

export interface WorkingMemory {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  toJSON(): Record<string, unknown>;
}

export interface AgentContext {
  session: Session;
  messages: ModelMessage[];
  workingMemory: WorkingMemory;
  currentAgent: string;
  turnCount: number;
  metadata: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

// ============================================
// SESSION TYPES
// ============================================

export interface Session {
  id: string;
  conversationId: string;
  channelId: ChannelId;
  userId?: string;
  createdAt: Date;
  updatedAt: Date;
  messages: ModelMessage[];
  workingMemory: Record<string, unknown>;
  currentAgent: string;
  activeAgentId?: string;
  state?: Record<string, unknown>;
  metadata?: SessionMetadata;
  agentStates: Record<string, AgentState>;
  handoffHistory: HandoffRecord[];
  /** @internal Latest refinement decision for the active turn. Cleared after post-stream persistence. */
  pendingRefinement?: RefinementStageResult;
  /** @internal Pending key-facts extraction promises. Awaited before session save. */
  __pendingExtractions?: Promise<void>[];
}

export interface SessionMetadata {
  createdAt: Date;
  lastActiveAt: Date;
  totalTokens: number;
  totalSteps: number;
  handoffHistory: HandoffRecord[];
  outcome?: ConversationOutcomeRecord;
  csat?: CsatRecord;
  /** Whether the previous turn involved at least one tool call. */
  lastTurnHadToolCalls?: boolean;
  /** Previous turn's aggregate refinement confidence, when refinement was configured. */
  lastRefinementConfidence?: number;
  /** Previous turn's aggregate validation confidence, when validation was configured. */
  lastValidationConfidence?: number;
  /** Previous escalation outcome, when the escalation gate was triggered. */
  lastEscalation?: {
    at: string;
    reason: EscalationReason;
    handlerOutcome: EscalationOutcome['status'];
  };
  lastSafetyOutcome?: {
    at: string;
    moderator: string;
    decision: 'rewrite' | 'block';
    rationale?: string;
  };
  personaExperiment?: PersonaExperimentMetadata;
  channelHistory?: Array<{ channelId: ChannelId; at: string }>;
  audit?: ConversationAuditEntry[];
}

export interface AgentState {
  agentId: string;
  state: Record<string, unknown>;
  lastActive: Date;
}

export interface HandoffRecord {
  from: string;
  to: string;
  reason: string;
  timestamp: Date;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Stable key for idempotent external side effects (webhook/DB/CRM writes). */
  idempotencyKey?: string;
  result?: unknown;
  error?: Error;
  success: boolean;
  timestamp: number;
  durationMs?: number;
}

export interface RunContext {
  session: Session;
  agentId: string;
  stepCount: number;
  totalTokens: number;
  handoffStack: string[];
  startTime: number;
  consecutiveErrors: number;
  toolCallHistory: ToolCallRecord[];
  /**
   * Session-level retrieval cache. Created by KnowledgeProvider at turn
   * start, persists across agent handoffs within the same session.
   * Stores recent retrieval results indexed by document embedding for
   * sub-millisecond semantic lookup.
   */
  retrievalCache?: RetrievalCacheAdapter;
  /** Unique identifier for this turn, used by TurnCache for dedup. */
  turnId?: string;
}
