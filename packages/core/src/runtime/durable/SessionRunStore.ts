import type { Session } from '../../types/session.js';
import { StaleWriteError, type SessionStore } from '../../session/SessionStore.js';
import type { RunState, StepRecord, PersistedRun, SessionDurableRuns } from './types.js';
import { DURABLE_RUNS_KEY } from './types.js';
import {
  LogConflictError,
  RunNotFoundError,
  StepNotFoundError,
  type RunStore,
  type StepFinalizePatch,
} from './RunStore.js';

function cloneSession<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function readRuns(session: Session): SessionDurableRuns {
  const runs = (session as Session & { [DURABLE_RUNS_KEY]?: SessionDurableRuns })[DURABLE_RUNS_KEY];
  return runs ?? {};
}

function writeRuns(session: Session, runs: SessionDurableRuns): void {
  (session as Session & { [DURABLE_RUNS_KEY]?: SessionDurableRuns })[DURABLE_RUNS_KEY] = runs;
}

function getPersistedRun(session: Session, runId: string): PersistedRun | undefined {
  return readRuns(session)[runId];
}

export class SessionRunStore implements RunStore {
  private static readonly CAS_RETRIES = 8;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly sessionId: string,
  ) {}

  private async mutateSession(mutator: (session: Session) => void | Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < SessionRunStore.CAS_RETRIES; attempt++) {
      const session = await this.requireSession();
      await mutator(session);
      try {
        await this.sessionStore.save(session);
        return;
      } catch (error) {
        if (error instanceof StaleWriteError && attempt < SessionRunStore.CAS_RETRIES - 1) {
          continue;
        }
        throw error;
      }
    }
  }

  async appendStep(runId: string, record: StepRecord): Promise<void> {
    await this.mutateSession((session) => {
      const runs = readRuns(session);
      const persisted = runs[runId];
      if (!persisted) {
        throw new RunNotFoundError(runId);
      }

      const existingAtIndex = persisted.steps[record.index];
      if (existingAtIndex?.name === '__reserve') {
        if (persisted.steps.some((step) => step.key === record.key && step.index !== record.index)) {
          throw new LogConflictError(runId, record.index, persisted.steps.length);
        }
        persisted.steps[record.index] = cloneSession(record);
      } else if (persisted.steps.length !== record.index) {
        throw new LogConflictError(runId, record.index, persisted.steps.length);
      } else if (persisted.steps.some((step) => step.key === record.key)) {
        throw new LogConflictError(runId, record.index, persisted.steps.length);
      } else {
        persisted.steps.push(cloneSession(record));
      }
      persisted.runState.updatedAt = Date.now();
      runs[runId] = persisted;
      writeRuns(session, runs);
    });
  }

  async finalizeStep(runId: string, key: string, patch: StepFinalizePatch): Promise<void> {
    await this.mutateSession((session) => {
      const runs = readRuns(session);
      const persisted = runs[runId];
      if (!persisted) {
        throw new RunNotFoundError(runId);
      }

      const stepIndex = persisted.steps.findIndex((step) => step.key === key);
      if (stepIndex === -1) {
        throw new StepNotFoundError(runId, key);
      }

      const existing = persisted.steps[stepIndex]!;
      persisted.steps[stepIndex] = cloneSession({
        ...existing,
        ...patch,
        index: existing.index,
        key: existing.key,
        kind: existing.kind,
        name: existing.name,
        startedAt: existing.startedAt,
        epoch: existing.epoch,
      });
      persisted.runState.updatedAt = Date.now();
      runs[runId] = persisted;
      writeRuns(session, runs);
    });
  }

  async reserveSteps(runId: string, count: number): Promise<number[]> {
    if (count <= 0) {
      return [];
    }

    let indices: number[] = [];
    await this.mutateSession((session) => {
      const runs = readRuns(session);
      const persisted = runs[runId];
      if (!persisted) {
        throw new RunNotFoundError(runId);
      }

      const start = persisted.steps.length;
      const now = Date.now();
      const epoch = persisted.runState.runEpoch ?? 0;
      indices = [];

      for (let i = 0; i < count; i++) {
        const index = start + i;
        indices.push(index);
        persisted.steps.push({
          index,
          key: `__reserve:${runId}:${index}`,
          kind: 'tool',
          name: '__reserve',
          status: 'running',
          startedAt: now,
          epoch,
        });
      }

      persisted.runState.updatedAt = now;
      runs[runId] = persisted;
      writeRuns(session, runs);
    });
    return indices;
  }

  async getSteps(runId: string): Promise<StepRecord[]> {
    const session = await this.requireSession();
    const persisted = getPersistedRun(session, runId);
    if (!persisted) {
      return [];
    }
    return persisted.steps.map((step) => cloneSession(step));
  }

  async getRunState(runId: string): Promise<RunState | null> {
    const session = await this.requireSession();
    const persisted = getPersistedRun(session, runId);
    return persisted ? cloneSession(persisted.runState) : null;
  }

  async putRunState(state: RunState): Promise<void> {
    await this.mutateSession((session) => {
      const runs = readRuns(session);
      const existing = runs[state.runId];
      runs[state.runId] = {
        runState: cloneSession({ ...state, updatedAt: Date.now() }),
        steps: existing?.steps.map((step) => cloneSession(step)) ?? [],
      };
      writeRuns(session, runs);
    });
  }

  async initRun(state: RunState): Promise<void> {
    await this.mutateSession((session) => {
      const runs = readRuns(session);
      runs[state.runId] = {
        runState: cloneSession(state),
        steps: [],
      };
      writeRuns(session, runs);
    });
  }

  async pruneStepsBeforeEpoch(runId: string, keepEpoch: number): Promise<void> {
    await this.mutateSession((session) => {
      const runs = readRuns(session);
      const persisted = runs[runId];
      if (!persisted) {
        return;
      }

      const kept = persisted.steps.filter(
        (step) => step.epoch === undefined || step.epoch >= keepEpoch,
      );
      persisted.steps = kept.map((step, index) => ({ ...cloneSession(step), index }));
      persisted.runState.updatedAt = Date.now();
      runs[runId] = persisted;
      writeRuns(session, runs);
    });
  }

  private async requireSession(): Promise<Session> {
    const session = await this.sessionStore.get(this.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${this.sessionId}`);
    }
    return session;
  }
}
