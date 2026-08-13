import { describe, expect, it } from 'bun:test';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { runRunStoreContract } from '../../src/runtime/durable/testing.js';
import { makeRunState, makeTestSession } from './helpers.js';

runRunStoreContract(async () => {
  const memory = new MemoryStore();
  const sessionId = 'conformance';
  await memory.save(makeTestSession(sessionId));
  return new SessionRunStore(memory, sessionId);
});

describe('SessionRunStore listRuns scans every session', () => {
  it('yields runs stored under different sessions from one enumerator', async () => {
    const memory = new MemoryStore();
    await memory.save(makeTestSession('sess-a'));
    await memory.save(makeTestSession('sess-b'));
    const storeA = new SessionRunStore(memory, 'sess-a');
    const storeB = new SessionRunStore(memory, 'sess-b');
    await storeA.putRunState(makeRunState('sess-a', 'run-a'));
    await storeB.putRunState({ ...makeRunState('sess-b', 'run-b'), kind: 'flow', activeFlow: 'checkout' });

    const ids: string[] = [];
    for await (const ref of storeA.listRuns({})) {
      ids.push(ref.runId);
    }
    expect(ids.sort()).toEqual(['run-a', 'run-b']);

    const flows: string[] = [];
    for await (const ref of storeB.listRuns({ kind: 'flow' })) {
      flows.push(ref.runId);
      expect(ref.sessionId).toBe('sess-b');
      expect(ref.flowName).toBe('checkout');
    }
    expect(flows).toEqual(['run-b']);
  });
});
