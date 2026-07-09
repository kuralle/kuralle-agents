import type { StepRecord, RunState } from './types.js';

export class LogConflictError extends Error {
  readonly runId: string;
  readonly expectedIndex: number;
  readonly actualIndex: number;

  constructor(runId: string, expectedIndex: number, actualIndex: number) {
    super(
      `Log conflict for run ${runId}: expected append at index ${expectedIndex}, current length is ${actualIndex}`,
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

export interface RunStore {
  appendStep(runId: string, record: StepRecord): Promise<void>;
  getSteps(runId: string): Promise<StepRecord[]>;
  getRunState(runId: string): Promise<RunState | null>;
  putRunState(state: RunState): Promise<void>;
}
