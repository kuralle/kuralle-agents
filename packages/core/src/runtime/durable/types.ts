import type { ModelMessage } from 'ai';

export type StepKind = 'tool' | 'approval' | 'signal' | 'now' | 'uuid';

export type StepStatus = 'running' | 'paused' | 'finished' | 'error' | 'aborted';

export interface StepRecord {
  index: number;
  key: string;
  kind: StepKind;
  name: string;
  signalId?: string;
  result?: unknown;
  error?: { name: string; message: string };
  /** Intent lifecycle: `running` = pending execute; `finished`/`error` = finalized. Legacy steps omit status. */
  status?: StepStatus;
  startedAt: number;
  finishedAt?: number;
  /** Logical-run epoch when this step was recorded. Absent on legacy steps → prune keeps them until superseded. */
  epoch?: number;
  interruptDecision?: InterruptDecisionRecord;
}

export interface SignalActor {
  id: string;
  type: 'user' | 'service' | 'system';
}

export interface FrozenToolOperation {
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsHash: string;
  effectKey: string;
  callsite: string;
  stepIndex?: number;
  source: 'model' | 'action';
  flow?: string;
  node?: string;
}

export interface InterruptRequest {
  requestId: string;
  kind: 'approval' | 'signal';
  signalName: string;
  callsite: string;
  /** Durable step key consumed when the suspended call resumes. */
  resumeKey: string;
  createdAt: number;
  deadline: number | null;
  meta?: Record<string, unknown>;
  display: { title: string; description?: string };
  allowedDecisions: Array<'approve' | 'deny'>;
  responseSchema: Record<string, unknown>;
  operation?: FrozenToolOperation;
  continuation?: ModelMessage[];
}

export interface InterruptDecisionRecord {
  requestId: string;
  signalId: string;
  actor: SignalActor;
  decision?: 'approve' | 'deny';
  reason?: string;
  decidedAt: number;
}

export interface PersistedFlowFrame {
  flow: string;
  state: Record<string, unknown>;
}

export interface PersistedFlowPark extends PersistedFlowFrame {
  node: string;
}

export interface RunState {
  runId: string;
  sessionId: string;
  status: 'running' | 'paused' | 'finished' | 'error' | 'aborted';
  activeAgentId: string;
  activeFlow?: string;
  activeNode?: string;
  /** State owned by the active flow. It is persisted independently from root runtime state. */
  flowFrame?: PersistedFlowFrame;
  /** Suspended parent flow frames, ordered outermost to innermost. */
  flowStack?: PersistedFlowPark[];
  state: Record<string, unknown>;
  waitingFor?: InterruptRequest;
  messages: ModelMessage[];
  createdAt: number;
  updatedAt: number;
  /** Monotonic logical-run counter. Increments on each fresh turn; stable across suspend/resume.
   *  Scopes the durable effect-key namespace so a new turn re-executes rather than replaying a
   *  prior turn's cached result (F6/G8). Absent on legacy runs → treat as 0. */
  runEpoch?: number;
  /** Which effect-key scheme this run's journal was written under. Version 1 scopes a
   *  flow's effects by flow name; before it, callsites were rebased to 0 on every flow
   *  entry with no flow in the key, so a resumed in-flow run would not find its own
   *  recorded steps and would re-execute their side effects. Absent on a run journaled
   *  before the change — see `assertResumableEffectKeys`. */
  effectKeyVersion?: number;
  /** Inbound message idempotency keys already accepted (H2 webhook-retry dedup). */
  processedInboundKeys?: string[];
}

export interface SignalDelivery {
  signalId: string;
  requestId: string;
  name: string;
  actor: SignalActor;
  decision?: 'approve' | 'deny';
  reason?: string;
  payload?: unknown;
}

export interface PersistedRun {
  runState: RunState;
  steps: StepRecord[];
}

export const DURABLE_RUNS_KEY = 'durableRuns' as const;

export type SessionDurableRuns = Record<string, PersistedRun>;
