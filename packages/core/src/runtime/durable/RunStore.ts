import type { StepRecord, RunState, RunFilter, RunRef } from './types.js';

export class LogConflictError extends Error {
  readonly runId: string;
  readonly expectedIndex: number;
  readonly actualIndex: number;

  constructor(runId: string, expectedIndex: number, actualIndex: number) {
    super(
      `Log conflict for run ${runId}: expected append at index ${expectedIndex}, current length is ${actualIndex}. For parallel durable effects, use ctx.tool directly or reserve callsites with ctx.reserveCallsites(count) before supplying explicit indices.`,
    );
    this.name = 'LogConflictError';
    this.runId = runId;
    this.expectedIndex = expectedIndex;
    this.actualIndex = actualIndex;
  }
}

export class SuspendError extends Error {
  readonly waitingFor: string;

  constructor(waitingFor: string) {
    super(`Run suspended waiting for ${waitingFor}`);
    this.name = 'SuspendError';
    this.waitingFor = waitingFor;
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class StepNotFoundError extends Error {
  constructor(runId: string, key: string) {
    super(`Step not found for run ${runId}: ${key}`);
    this.name = 'StepNotFoundError';
  }
}

export class RunNotTerminalError extends Error {
  readonly runId: string;
  readonly status: RunState['status'];

  constructor(runId: string, status: RunState['status']) {
    super(
      `Refusing to delete run ${runId} in non-terminal status '${status}'. Pass { force: true } to delete a live run.`,
    );
    this.name = 'RunNotTerminalError';
    this.runId = runId;
    this.status = status;
  }
}

export interface DeleteRunOptions {
  force?: boolean;
}

export function isTerminalRunStatus(status: RunState['status']): boolean {
  return status === 'finished' || status === 'error' || status === 'aborted';
}

export interface StepFinalizePatch {
  status: 'finished' | 'error';
  result?: unknown;
  error?: { name: string; message: string };
  finishedAt?: number;
}

export interface RunStore {
  appendStep(runId: string, record: StepRecord): Promise<void>;
  finalizeStep(runId: string, key: string, patch: StepFinalizePatch): Promise<void>;
  getSteps(runId: string): Promise<StepRecord[]>;
  getRunState(runId: string): Promise<RunState | null>;
  putRunState(state: RunState): Promise<void>;
  initRun?(state: RunState): Promise<void>;
  pruneStepsBeforeEpoch?(runId: string, keepEpoch: number): Promise<void>;
  reserveSteps?(runId: string, count: number): Promise<number[]>;
  listRuns(filter: RunFilter): AsyncIterable<RunRef>;
  deleteRun(runId: string, options?: DeleteRunOptions): Promise<void>;
}
