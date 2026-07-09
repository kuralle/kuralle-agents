import type { Session } from '../../types/session.js';
import type { SessionStore } from '../../session/SessionStore.js';
import type { RunState, StepRecord, PersistedRun, SessionDurableRuns } from './types.js';
import { DURABLE_RUNS_KEY } from './types.js';
import { LogConflictError, RunNotFoundError, type RunStore } from './RunStore.js';

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
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly sessionId: string,
  ) {}

  async appendStep(runId: string, record: StepRecord): Promise<void> {
    const session = await this.requireSession();
    const runs = readRuns(session);
    const persisted = runs[runId];
    if (!persisted) {
      throw new RunNotFoundError(runId);
    }

    if (persisted.steps.length !== record.index) {
      throw new LogConflictError(runId, record.index, persisted.steps.length);
    }

    if (persisted.steps.some((step) => step.key === record.key)) {
      throw new LogConflictError(runId, record.index, persisted.steps.length);
    }

    persisted.steps.push(cloneSession(record));
    persisted.runState.updatedAt = Date.now();
    runs[runId] = persisted;
    writeRuns(session, runs);
    await this.sessionStore.save(session);
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
    const session = await this.requireSession();
    const runs = readRuns(session);
    const existing = runs[state.runId];
    runs[state.runId] = {
      runState: cloneSession({ ...state, updatedAt: Date.now() }),
      steps: existing?.steps.map((step) => cloneSession(step)) ?? [],
    };
    writeRuns(session, runs);
    await this.sessionStore.save(session);
  }

  async initRun(state: RunState): Promise<void> {
    const session = await this.requireSession();
    const runs = readRuns(session);
    runs[state.runId] = {
      runState: cloneSession(state),
      steps: [],
    };
    writeRuns(session, runs);
    await this.sessionStore.save(session);
  }

  private async requireSession(): Promise<Session> {
    const session = await this.sessionStore.get(this.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${this.sessionId}`);
    }
    return session;
  }
}
