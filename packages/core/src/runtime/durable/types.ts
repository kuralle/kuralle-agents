import type { ModelMessage, UserContent } from 'ai';
import type { FlowVerificationRecord } from '../../flows/definition/types.js';

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

export interface RunFlowRef {
  name: string;
  versionId?: string;
}

export interface PersistedFlowPark extends PersistedFlowFrame {
  node: string;
  /** Digest of the parked parent, restored on pop so parent drift is still fail-closed. */
  flowDigest?: string;
  flowRef?: RunFlowRef;
}

export type RunKind = 'conversation' | 'flow';

export interface RunState {
  runId: string;
  sessionId: string;
  /**
   * Conversation runs own the chat turn loop (one per session, keyed by sessionId).
   * Flow runs are one execution of a flow and live under their own key.
   * Absent on runs persisted before run identity — treated as `'conversation'`.
   */
  kind?: RunKind;
  status: 'running' | 'paused' | 'finished' | 'error' | 'aborted';
  activeAgentId: string;
  activeFlow?: string;
  activeNode?: string;
  /**
   * Canonical digest of the flow this run entered. Stamped on entry, compared
   * on resume. Absent on runs journaled before digest pinning — those resume
   * as they did (classify, don't break). Integrity metadata: never taken from
   * a caller argument to force a resume.
   */
  flowDigest?: string;
  /** Store identity of the flow this run entered, when it came from a published version. */
  flowRef?: RunFlowRef;
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
  /** Which effect-key scheme this run's journal was written under. Version 2 scopes a
   *  flow's effects by `flow@digest`; version 1 scoped by flow name only. Before
   *  version 1, callsites were rebased to 0 on every flow entry with no flow in the
   *  key, so a resumed in-flow run would not find its own recorded steps and would
   *  re-execute their side effects. Absent on a run journaled before version 1 —
   *  see `assertResumableEffectKeys`. Version 1 journals are legacy-resumable. */
  effectKeyVersion?: number;
  /** Inbound message idempotency keys already accepted (H2 webhook-retry dedup). */
  processedInboundKeys?: string[];
  /**
   * Per-run pending-input FIFO for `kind: 'flow'`. Conversation runs keep using
   * the session working-memory buffer; flow runs must not.
   */
  pendingInput?: UserContent[];
  /** Message count at the last completed extraction; drives the token trigger. */
  lastExtractedMessageCount?: number;
  /**
   * Post-run verification of this flow, recorded when the flow reached a terminal
   * transition that declared `gates`. Absent when the flow has no gates.
   */
  verification?: FlowVerificationRecord;
  /**
   * Holder of the execution lease. Taken at run open, renewed on persist
   * points during the turn, cleared at close. Absent means no live executor
   * (idle between turns, or a run that never opened under this scheme).
   */
  leaseHolder?: string;
  /** Epoch ms when the execution lease expires. A past expiry is a crashed replica; a missing lease is idle, not stale. */
  leaseExpiresAt?: number;
}

export interface SignalDelivery {
  signalId: string;
  requestId: string;
  name: string;
  actor: SignalActor;
  decision?: 'approve' | 'deny';
  reason?: string;
  payload?: unknown;
  /**
   * Resume this run. Must already exist under the session named on the request.
   * Unknown and cross-session values fail closed. Omit to scan the session for a
   * matching `waitingFor` (legacy clients that only send sessionId).
   */
  runId?: string;
}

export interface PersistedRun {
  runState: RunState;
  steps: StepRecord[];
}

export const DURABLE_RUNS_KEY = 'durableRuns' as const;

export type SessionDurableRuns = Record<string, PersistedRun>;

export function runKind(run: { kind?: RunKind }): RunKind {
  return run.kind ?? 'conversation';
}

export type RunStatus = RunState['status'];

export interface RunFilter {
  status?: RunStatus;
  kind?: RunKind;
  flowName?: string;
  waitingSignalId?: string;
  deadlineBefore?: Date;
}

export interface RunRef {
  runId: string;
  sessionId?: string;
  status: RunStatus;
  kind: RunKind;
  flowName?: string;
  waitingFor?: InterruptRequest;
  updatedAt: number;
  leaseExpiresAt?: number;
}

export function runMatchesFilter(state: RunState, filter: RunFilter): boolean {
  if (filter.status !== undefined && state.status !== filter.status) return false;
  if (filter.kind !== undefined && runKind(state) !== filter.kind) return false;
  if (filter.flowName !== undefined && state.activeFlow !== filter.flowName) return false;
  if (filter.waitingSignalId !== undefined) {
    if (state.waitingFor?.requestId !== filter.waitingSignalId) return false;
  }
  if (filter.deadlineBefore !== undefined) {
    const deadline = state.waitingFor?.deadline;
    if (deadline == null || deadline >= filter.deadlineBefore.getTime()) return false;
  }
  return true;
}

export function toRunRef(state: RunState, storedInSessionId?: string): RunRef {
  const ref: RunRef = {
    runId: state.runId,
    sessionId: storedInSessionId ?? state.sessionId,
    status: state.status,
    kind: runKind(state),
    updatedAt: state.updatedAt,
  };
  if (state.activeFlow !== undefined) ref.flowName = state.activeFlow;
  if (state.waitingFor !== undefined) ref.waitingFor = state.waitingFor;
  if (state.leaseExpiresAt !== undefined) ref.leaseExpiresAt = state.leaseExpiresAt;
  return ref;
}

export function readSessionDurableRuns(session: object): SessionDurableRuns {
  return (session as { [DURABLE_RUNS_KEY]?: SessionDurableRuns })[DURABLE_RUNS_KEY] ?? {};
}
