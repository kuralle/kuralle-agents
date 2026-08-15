import { env, evictDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  LogConflictError,
  RunNotFoundError,
  RunNotTerminalError,
  StepNotFoundError,
  StaleWriteError,
  type DeleteRunOptions,
  type RunFilter,
  type RunRef,
  type RunState,
  type RunStore,
  type StepFinalizePatch,
  type StepRecord,
} from '@kuralle-agents/core';
import { runRunStoreContract } from '@kuralle-agents/core/runtime/durable/testing';

interface TestMemoryEnv {
  TEST_MEMORY_DO: DurableObjectNamespace;
}

const T0 = 1_700_000_000_000;

function runState(runId: string, overrides: Partial<RunState> = {}): RunState {
  return {
    runId,
    sessionId: 'conformance',
    status: 'running',
    activeAgentId: 'agent-1',
    state: {},
    messages: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const journalStep: StepRecord = {
  index: 0,
  key: 'k0',
  kind: 'tool',
  name: 'charge',
  status: 'finished',
  startedAt: T0,
  finishedAt: T0,
  epoch: 0,
};

function reviveError(payload: {
  name: string;
  message: string;
  runId?: string;
  expectedIndex?: number;
  actualIndex?: number;
  status?: RunState['status'];
  sessionId?: string;
  expectedVersion?: number;
  actualVersion?: number;
}): Error {
  switch (payload.name) {
    case 'LogConflictError':
      return new LogConflictError(payload.runId ?? '', payload.expectedIndex ?? 0, payload.actualIndex ?? 0);
    case 'RunNotFoundError':
      return new RunNotFoundError(payload.runId ?? payload.message);
    case 'RunNotTerminalError':
      return new RunNotTerminalError(payload.runId ?? '', payload.status ?? 'running');
    case 'StepNotFoundError':
      return new StepNotFoundError(payload.runId ?? '', payload.message);
    case 'StaleWriteError':
      return new StaleWriteError(
        payload.sessionId ?? '',
        payload.expectedVersion ?? 0,
        payload.actualVersion ?? 0,
      );
    default:
      return Object.assign(new Error(payload.message), { name: payload.name });
  }
}

class RpcRunStore implements RunStore {
  constructor(private readonly stub: DurableObjectStub) {}

  private async call<T>(body: unknown): Promise<T> {
    const response = await this.stub.fetch('http://do/run-store', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; error?: Parameters<typeof reviveError>[0] };
    if (!payload.ok) {
      throw reviveError(payload.error ?? { name: 'Error', message: 'run-store rpc failed' });
    }
    return payload.result as T;
  }

  appendStep(runId: string, record: StepRecord): Promise<void> {
    return this.call({ op: 'appendStep', runId, record });
  }

  finalizeStep(runId: string, key: string, patch: StepFinalizePatch): Promise<void> {
    return this.call({ op: 'finalizeStep', runId, key, patch });
  }

  getSteps(runId: string): Promise<StepRecord[]> {
    return this.call({ op: 'getSteps', runId });
  }

  getRunState(runId: string): Promise<RunState | null> {
    return this.call({ op: 'getRunState', runId });
  }

  putRunState(state: RunState): Promise<void> {
    return this.call({ op: 'putRunState', state }).then((result) => {
      const returned = result as RunState;
      if (returned && typeof returned === 'object' && 'version' in returned) {
        (state as RunState & { version?: number }).version = (returned as RunState & { version?: number }).version;
      }
    });
  }

  initRun(state: RunState): Promise<void> {
    return this.call({ op: 'initRun', state });
  }

  pruneStepsBeforeEpoch(runId: string, keepEpoch: number): Promise<void> {
    return this.call({ op: 'pruneStepsBeforeEpoch', runId, keepEpoch });
  }

  reserveSteps(runId: string, count: number): Promise<number[]> {
    return this.call({ op: 'reserveSteps', runId, count });
  }

  async *listRuns(filter: RunFilter): AsyncIterable<RunRef> {
    const refs = await this.call<RunRef[]>({ op: 'listRuns', filter });
    yield* refs;
  }

  deleteRun(runId: string, options?: DeleteRunOptions): Promise<void> {
    return this.call({ op: 'deleteRun', runId, options });
  }
}

function freshStore(): RpcRunStore {
  const bindings = env as unknown as TestMemoryEnv;
  const id = bindings.TEST_MEMORY_DO.idFromName(`run-store-${crypto.randomUUID()}`);
  return new RpcRunStore(bindings.TEST_MEMORY_DO.get(id));
}

runRunStoreContract(
  () => freshStore(),
  { describe, test, expect, beforeEach },
);

describe('SqlRunStore workerd sqlite dialect', () => {
  test('appendStep maps unique-violation to LogConflictError without a pre-check', async () => {
    const store = freshStore();
    await store.putRunState(runState('r-conflict'));
    await store.appendStep('r-conflict', journalStep);

    await expect(store.appendStep('r-conflict', { ...journalStep, key: 'k-dup' })).rejects.toBeInstanceOf(
      LogConflictError,
    );
  });

  test('a run written pre-eviction resumes post-wake with an intact journal', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const id = bindings.TEST_MEMORY_DO.idFromName('run-store-hibernation');
    const stub = bindings.TEST_MEMORY_DO.get(id);
    const store = new RpcRunStore(stub);

    await store.putRunState(runState('r-hibernate', { status: 'paused', activeFlow: 'checkout' }));
    await store.appendStep('r-hibernate', journalStep);
    await store.appendStep('r-hibernate', { ...journalStep, index: 1, key: 'k1', name: 'notify' });

    await evictDurableObject(stub);

    const woken = new RpcRunStore(stub);
    const restored = await woken.getRunState('r-hibernate');
    expect(restored?.runId).toBe('r-hibernate');
    expect(restored?.status).toBe('paused');
    expect(restored?.activeFlow).toBe('checkout');
    expect((await woken.getSteps('r-hibernate')).map((step) => step.key)).toEqual(['k0', 'k1']);
  });
});
