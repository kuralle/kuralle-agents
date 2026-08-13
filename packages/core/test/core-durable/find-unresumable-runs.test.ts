import { describe, expect, it } from 'bun:test';
import { findUnresumableRuns } from '../../src/runtime/durable/findUnresumableRuns.js';
import { EFFECT_KEY_VERSION } from '../../src/runtime/durable/effectKeyVersion.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { makeRunState, makeTestSession } from './helpers.js';
import type { RunState, StepRecord } from '../../src/runtime/durable/types.js';

// "Drain your paused sessions before upgrading" is only actionable if an operator can
// find them. These are the two runs this version refuses, and they must be discoverable
// from the store before a deploy rather than by a user mid-conversation.
describe('findUnresumableRuns', () => {
  const step = {
    index: 0,
    key: 'k',
    kind: 'tool',
    name: 't',
    status: 'finished',
    startedAt: 0,
    finishedAt: 0,
    epoch: 0,
  } as unknown as StepRecord;

  async function seed(
    store: MemoryStore,
    sessionId: string,
    mutate: (run: RunState) => void,
    withStep = true,
  ): Promise<void> {
    const session = makeTestSession(sessionId);
    await store.save(session);
    const runStore = new SessionRunStore(store, sessionId);
    const run = makeRunState(sessionId, sessionId);
    mutate(run);
    await runStore.initRun(run);
    if (withStep) await runStore.appendStep(run.runId, step);
  }

  it('finds a run paused on a pre-request-bound approval', async () => {
    const store = new MemoryStore();
    await seed(store, 's-approval', (run) => {
      run.status = 'paused';
      run.effectKeyVersion = EFFECT_KEY_VERSION;
      run.waitingFor = {
        requestId: 'req-old',
        signalName: '__approval',
        kind: 'approval',
        callsite: '0',
      } as RunState['waitingFor'];
    });

    const found = await findUnresumableRuns(store);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe('legacy-approval');
    expect(found[0]!.waitingFor).toBe('__approval');
    expect(found[0]!.sessionId).toBe('s-approval');
  });

  it('finds an in-flow run journaled under the old effect-key scheme', async () => {
    const store = new MemoryStore();
    await seed(store, 's-flow', (run) => {
      run.activeFlow = 'checkout';
      delete run.effectKeyVersion;
    });

    const found = await findUnresumableRuns(store);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe('legacy-effect-keys');
    expect(found[0]!.activeFlow).toBe('checkout');
    // Names the blast radius: this many effects would re-run if forced through.
    expect(found[0]!.recordedSteps).toBe(1);
  });

  it('ignores runs that upgrade cleanly', async () => {
    const store = new MemoryStore();
    // Current scheme, inside a flow.
    await seed(store, 's-ok', (run) => {
      run.activeFlow = 'checkout';
      run.effectKeyVersion = EFFECT_KEY_VERSION;
    });
    // Flow-name scheme (v1) — legacy-resumable after the digest bump.
    await seed(store, 's-v1', (run) => {
      run.activeFlow = 'checkout';
      run.effectKeyVersion = 1;
    });
    // Old scheme but outside a flow — the key is unchanged there.
    await seed(store, 's-no-flow', (run) => {
      delete run.effectKeyVersion;
    });
    // Old scheme, inside a flow, but nothing journaled — nothing to mis-key.
    await seed(
      store,
      's-empty',
      (run) => {
        run.activeFlow = 'checkout';
        delete run.effectKeyVersion;
      },
      false,
    );

    expect(await findUnresumableRuns(store)).toEqual([]);
  });

  it('checks only the sessions asked for when given a subset', async () => {
    const store = new MemoryStore();
    await seed(store, 's-flow', (run) => {
      run.activeFlow = 'checkout';
      delete run.effectKeyVersion;
    });
    await seed(store, 's-other', (run) => {
      run.activeFlow = 'other';
      delete run.effectKeyVersion;
    });

    const found = await findUnresumableRuns(store, { sessionIds: ['s-flow'] });
    expect(found.map((r) => r.sessionId)).toEqual(['s-flow']);
  });
});
