import type { Session } from '../../types/session.js';
import { StaleWriteError, type SessionStore } from '../../session/SessionStore.js';
import type { RunState, StepRecord, PersistedRun, SessionDurableRuns, RunFilter, RunRef } from './types.js';
import { DURABLE_RUNS_KEY, readSessionDurableRuns, runMatchesFilter, toRunRef } from './types.js';
import {
  LogConflictError,
  RunNotFoundError,
  RunNotTerminalError,
  StepNotFoundError,
  isTerminalRunStatus,
  type DeleteRunOptions,
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
  return readSessionDurableRuns(session);
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

  private async mutateSession(
    mutator: (session: Session) => void | Promise<void>,
    sessionId: string = this.sessionId,
  ): Promise<void> {
    for (let attempt = 0; attempt < SessionRunStore.CAS_RETRIES; attempt++) {
      const session = await this.requireSession(sessionId);
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
    if (!persisted?.runState) return null;
    return cloneSession(persisted.runState);
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

  async *listRuns(filter: RunFilter): AsyncIterable<RunRef> {
    const sessions = await this.sessionStore.list();
    for (const session of sessions) {
      const runs = readRuns(session);
      for (const persisted of Object.values(runs)) {
        if (!runMatchesFilter(persisted.runState, filter)) continue;
        yield cloneSession(toRunRef(persisted.runState, session.id));
      }
    }
  }

  async deleteRun(runId: string, options?: DeleteRunOptions): Promise<void> {
    const located = await this.findRunSession(runId);
    if (!located) {
      throw new RunNotFoundError(runId);
    }

    await this.mutateSession((session) => {
      const runs = readRuns(session);
      const existing = runs[runId];
      if (!existing) {
        throw new RunNotFoundError(runId);
      }
      if (!isTerminalRunStatus(existing.runState.status) && !options?.force) {
        throw new RunNotTerminalError(runId, existing.runState.status);
      }
      delete runs[runId];
      writeRuns(session, runs);
    }, located);
  }

  private async findRunSession(runId: string): Promise<string | null> {
    const bound = await this.sessionStore.get(this.sessionId);
    if (bound && getPersistedRun(bound, runId)) {
      return this.sessionId;
    }

    const sessions = await this.sessionStore.list();
    for (const session of sessions) {
      if (session.id === this.sessionId) continue;
      if (getPersistedRun(session, runId)) {
        return session.id;
      }
    }
    return null;
  }

  private async requireSession(sessionId: string = this.sessionId): Promise<Session> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
