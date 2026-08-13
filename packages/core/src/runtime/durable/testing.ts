/// <reference types="bun-types" />
/**
 * Shared contract-test harness for every `RunStore` adapter.
 *
 * Every store adapter (SessionRunStore, postgres-store, cf-agent DO-SQLite)
 * MUST pass this contract. Adapters call
 * `runRunStoreContract(() => new MyStore(...))` from within a `bun test`
 * test file.
 *
 * This helper is NOT re-exported from the package's main barrel — import
 * explicitly from `@kuralle-agents/core/runtime/durable/testing` to avoid
 * pulling `bun:test` into runtime bundles.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { InterruptRequest, RunFilter, RunRef, RunState, StepRecord } from './types.js';
import type { RunStore } from './RunStore.js';
import { RunNotFoundError, RunNotTerminalError } from './RunStore.js';

export type RunStoreFactory = () => RunStore | Promise<RunStore>;

const T0 = 1_700_000_000_000;

const MIXED_IDS = [
  'r-conv-running',
  'r-conv-paused',
  'r-flow-paused',
  'r-flow-other',
  'r-conv-finished',
  'r-flow-error',
  'r-flow-aborted',
] as const;

function interrupt(requestId: string, deadline: number | null): InterruptRequest {
  return {
    requestId,
    kind: 'approval',
    signalName: '__approval',
    callsite: '0',
    resumeKey: `resume:${requestId}`,
    createdAt: T0,
    deadline,
    display: { title: '__approval' },
    allowedDecisions: ['approve', 'deny'],
    responseSchema: {},
  };
}

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

async function seedMixed(store: RunStore): Promise<void> {
  await store.putRunState(runState('r-conv-running'));
  await store.putRunState(
    runState('r-conv-paused', {
      status: 'paused',
      waitingFor: interrupt('req-approval', T0 + 5_000),
    }),
  );
  await store.putRunState(
    runState('r-flow-paused', {
      kind: 'flow',
      status: 'paused',
      activeFlow: 'checkout',
      waitingFor: interrupt('req-flow', T0 + 1_000),
    }),
  );
  await store.putRunState(
    runState('r-flow-other', {
      kind: 'flow',
      status: 'paused',
      activeFlow: 'refund',
      waitingFor: interrupt('req-other', T0 + 9_000),
    }),
  );
  await store.putRunState(runState('r-conv-finished', { status: 'finished' }));
  await store.putRunState(
    runState('r-flow-error', { kind: 'flow', status: 'error', activeFlow: 'checkout' }),
  );
  await store.putRunState(
    runState('r-flow-aborted', { kind: 'flow', status: 'aborted', activeFlow: 'onboard' }),
  );
}

async function collectRefs(store: RunStore, filter: RunFilter): Promise<RunRef[]> {
  const refs: RunRef[] = [];
  for await (const ref of store.listRuns(filter)) {
    refs.push(ref);
  }
  return refs;
}

function idsOf(refs: RunRef[]): string[] {
  return refs.map((ref) => ref.runId).sort();
}

/**
 * Registers the shared RunStore contract tests. Must be invoked at the
 * top level of a bun test file.
 */
export function runRunStoreContract(factory: RunStoreFactory): void {
  describe('RunStore contract', () => {
    describe('listRuns filters', () => {
      let store: RunStore;

      beforeEach(async () => {
        store = await factory();
        await seedMixed(store);
      });

      test('empty filter returns every seeded run and no journal payload', async () => {
        const refs = await collectRefs(store, {});
        expect(idsOf(refs)).toEqual([...MIXED_IDS].sort());
        for (const ref of refs) {
          expect(ref).not.toHaveProperty('steps');
          expect(ref).not.toHaveProperty('messages');
          expect(ref).not.toHaveProperty('state');
        }
        const absentKind = refs.find((ref) => ref.runId === 'r-conv-running');
        expect(absentKind?.kind).toBe('conversation');
        expect(absentKind?.status).toBe('running');
      });

      test('filters by status', async () => {
        expect(idsOf(await collectRefs(store, { status: 'paused' }))).toEqual([
          'r-conv-paused',
          'r-flow-other',
          'r-flow-paused',
        ]);
        expect(idsOf(await collectRefs(store, { status: 'finished' }))).toEqual([
          'r-conv-finished',
        ]);
      });

      test('filters by kind, treating absent kind as conversation', async () => {
        expect(idsOf(await collectRefs(store, { kind: 'conversation' }))).toEqual([
          'r-conv-finished',
          'r-conv-paused',
          'r-conv-running',
        ]);
        expect(idsOf(await collectRefs(store, { kind: 'flow' }))).toEqual([
          'r-flow-aborted',
          'r-flow-error',
          'r-flow-other',
          'r-flow-paused',
        ]);
      });

      test('filters by flowName', async () => {
        expect(idsOf(await collectRefs(store, { flowName: 'checkout' }))).toEqual([
          'r-flow-error',
          'r-flow-paused',
        ]);
        expect(idsOf(await collectRefs(store, { flowName: 'refund' }))).toEqual(['r-flow-other']);
      });

      test('filters by waitingSignalId against waitingFor.requestId', async () => {
        const refs = await collectRefs(store, { waitingSignalId: 'req-approval' });
        expect(idsOf(refs)).toEqual(['r-conv-paused']);
        expect(refs[0]?.waitingFor?.requestId).toBe('req-approval');
        expect(refs[0]?.waitingFor?.signalName).toBe('__approval');
        expect(idsOf(await collectRefs(store, { waitingSignalId: 'req-flow' }))).toEqual([
          'r-flow-paused',
        ]);
      });

      test('filters by deadlineBefore against waitingFor.deadline', async () => {
        expect(idsOf(await collectRefs(store, { deadlineBefore: new Date(T0 + 3_000) }))).toEqual([
          'r-flow-paused',
        ]);
        expect(idsOf(await collectRefs(store, { deadlineBefore: new Date(T0 + 6_000) }))).toEqual([
          'r-conv-paused',
          'r-flow-paused',
        ]);
      });
    });

    describe('deleteRun', () => {
      let store: RunStore;

      beforeEach(async () => {
        store = await factory();
      });

      test('removes journal and state together for a terminal run', async () => {
        await store.putRunState(runState('r-del', { status: 'finished' }));
        await store.appendStep('r-del', journalStep);
        expect(await store.getRunState('r-del')).not.toBeNull();
        expect((await store.getSteps('r-del')).map((step) => step.key)).toEqual(['k0']);

        await store.deleteRun('r-del');

        expect(await store.getRunState('r-del')).toBeNull();
        expect(await store.getSteps('r-del')).toEqual([]);
      });

      test('refuses a paused run with a live approval unless force is passed', async () => {
        await store.putRunState(
          runState('r-paused', {
            status: 'paused',
            waitingFor: interrupt('req-live', T0 + 1_000),
          }),
        );
        await store.appendStep('r-paused', journalStep);

        await expect(store.deleteRun('r-paused')).rejects.toBeInstanceOf(RunNotTerminalError);
        expect(await store.getRunState('r-paused')).not.toBeNull();
        expect((await store.getSteps('r-paused')).length).toBe(1);

        await store.deleteRun('r-paused', { force: true });
        expect(await store.getRunState('r-paused')).toBeNull();
        expect(await store.getSteps('r-paused')).toEqual([]);
      });

      test('refuses a running run unless force is passed', async () => {
        await store.putRunState(runState('r-running', { status: 'running' }));

        await expect(store.deleteRun('r-running')).rejects.toBeInstanceOf(RunNotTerminalError);
        expect(await store.getRunState('r-running')).not.toBeNull();

        await store.deleteRun('r-running', { force: true });
        expect(await store.getRunState('r-running')).toBeNull();
      });

      test('throws RunNotFoundError for an unknown runId', async () => {
        await expect(store.deleteRun('does-not-exist')).rejects.toBeInstanceOf(RunNotFoundError);
      });
    });
  });
}
