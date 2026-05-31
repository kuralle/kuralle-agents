import type { ModelMessage } from 'ai';

export type StepKind = 'tool' | 'approval' | 'signal' | 'now' | 'uuid';

export interface StepRecord {
  index: number;
  key: string;
  kind: StepKind;
  name: string;
  signalId?: string;
  result?: unknown;
  error?: { name: string; message: string };
  startedAt: number;
  finishedAt?: number;
}

export interface WaitingFor {
  signalName: string;
  callsite: string;
  deadline?: number;
  meta?: Record<string, unknown>;
  approval?: { title: string; description?: string };
}

export interface RunState {
  runId: string;
  sessionId: string;
  status: 'running' | 'paused' | 'finished' | 'error' | 'aborted';
  activeAgentId: string;
  activeFlow?: string;
  activeNode?: string;
  state: Record<string, unknown>;
  waitingFor?: WaitingFor;
  messages: ModelMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface SignalDelivery {
  signalId: string;
  name: string;
  payload: unknown;
}

export interface PersistedRun {
  runState: RunState;
  steps: StepRecord[];
}

export const DURABLE_RUNS_KEY = 'durableRuns' as const;

export type SessionDurableRuns = Record<string, PersistedRun>;
