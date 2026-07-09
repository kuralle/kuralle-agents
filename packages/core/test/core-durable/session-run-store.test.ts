import { describe, expect, it } from 'bun:test';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { LogConflictError } from '../../src/runtime/durable/RunStore.js';
import { buildCtx, makeTestSession, setupDurableHarness } from './helpers.js';

describe('SessionRunStore over SessionStore (MemoryStore)', () => {
  it('persists run state and steps with CAS exactly-once semantics', async () => {
    const { session, memoryStore, runStore, runState } = await setupDurableHarness(
      'store-agnostic-sess',
      'store-agnostic-sess',
    );

    const reloaded = await runStore.getRunState(runState.runId);
    expect(reloaded?.activeAgentId).toBe(runState.activeAgentId);

    const spy = { count: 0 };
    const toolExecutor = {
      execute: async () => {
        spy.count += 1;
        return { ok: true };
      },
    };

    async function handler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('ping', {});
    }

    const ctx1 = await buildCtx({
      session,
      runStore,
      runState: reloaded!,
      toolExecutor,
    });
    await handler(ctx1);
    expect(spy.count).toBe(1);

    const ctx2 = await buildCtx({
      session: (await memoryStore.get(session.id))!,
      runStore,
      runState: (await runStore.getRunState(runState.runId))!,
      toolExecutor,
    });
    await handler(ctx2);
    expect(spy.count).toBe(1);
    expect((await runStore.getSteps(runState.runId)).length).toBe(1);
  });

  it('appendStep rejects out-of-order CAS with LogConflictError', async () => {
    const memory = new MemoryStore();
    const sessionId = 'cas-sess';
    const session = makeTestSession(sessionId);
    await memory.save(session);
    const runStore = new SessionRunStore(memory, sessionId);
    const runId = 'cas-run';
    await runStore.initRun({
      runId,
      sessionId: 'cas-sess',
      status: 'running',
      activeAgentId: 'a',
      state: {},
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await runStore.appendStep(runId, {
      index: 0,
      key: 'step-0',
      kind: 'tool',
      name: 'first',
      result: {},
      startedAt: Date.now(),
    });

    await expect(
      runStore.appendStep(runId, {
        index: 2,
        key: 'step-2',
        kind: 'tool',
        name: 'skip',
        result: {},
        startedAt: Date.now(),
      }),
    ).rejects.toBeInstanceOf(LogConflictError);
  });
});
