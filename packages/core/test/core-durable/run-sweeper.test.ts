import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow } from '../../src/types/flow.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { openRun } from '../../src/runtime/openRun.js';
import { recordSignalDelivery } from '../../src/runtime/durable/replay.js';
import { recoverOrphanedRuns, sweepDeadlines } from '../../src/runtime/durable/sweep.js';
import { isRunLeaseStale } from '../../src/runtime/durable/runLease.js';
import {
  DEADLINE_EXPIRED_REASON,
  deadlineExpiryDelivery,
} from '../../src/runtime/durable/deadlineExpiry.js';
import {
  createInProcessScheduler,
  createSweepJobRunner,
  isSweepJob,
  startRunSweeper,
  sweepJob,
  SWEEP_JOB_KIND,
} from '../../src/scheduler/index.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import { buildCtx, makeTestSession, setupDurableHarness, stubModel } from './helpers.js';

const defaultAgentId = 'agent-1';

function noopDriver(): ChannelDriver {
  return {
    async runAgentTurn() {
      return { text: '', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

describe('run lease', () => {
  it('is taken at openRun', async () => {
    const sessionStore = new MemoryStore();
    const agent = defineAgent({ id: defaultAgentId, model: stubModel });
    const opened = await openRun(new Map([[agent.id, agent]]), {
      sessionId: 'lease-open-sess',
      defaultAgentId,
      sessionStore,
      leaseHolder: 'holder-1',
    });
    expect(opened.runState.leaseHolder).toBe('holder-1');
    expect(opened.runState.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it('is cleared when a turn closes', async () => {
    const sessionStore = new MemoryStore();
    const charge = defineTool({
      name: 'charge',
      description: 'Charge',
      input: z.object({ amount: z.number() }),
      execute: async () => ({ charged: true }),
    });
    const node = action({
      id: 'charge',
      run: async (_state, ctx) => {
        await ctx.tool('charge', { amount: 1 });
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'lease-flow',
      description: 'd',
      start: node,
      nodes: [node],
    });
    const agent = defineAgent({
      id: defaultAgentId,
      model: stubModel,
      flows: [flow],
      tools: { charge },
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId,
      sessionStore,
      defaultModel: stubModel,
    });
    await runtime.run({
      sessionId: 'lease-close-sess',
      kind: 'flow',
      flowName: 'lease-flow',
      driver: noopDriver(),
    });
    const store = new SessionRunStore(sessionStore, 'lease-close-sess');
    const refs: string[] = [];
    for await (const ref of store.listRuns({ kind: 'flow' })) {
      refs.push(ref.runId);
      const state = await store.getRunState(ref.runId);
      expect(state?.leaseHolder).toBeUndefined();
      expect(state?.leaseExpiresAt).toBeUndefined();
      expect(state?.activeFlow).toBeUndefined();
    }
    expect(refs).toHaveLength(1);
  });
});

describe('crash recovery scan', () => {
  it('without the scan a crashed run stays running; recoverOrphanedRuns completes it exactly once', async () => {
    const sessionId = 'crash-sess';
    const sessionStore = new MemoryStore();

    const executeCount = { n: 0 };
    const sideEffects = { n: 0 };
    const seen = new Set<string>();
    let hangStarted = false;
    let releaseHang: (() => void) | undefined;
    let shouldHang = true;
    const charge = defineTool({
      name: 'charge',
      description: 'Charge once',
      input: z.object({ amount: z.number() }),
      idempotencyKey: (args) => `charge:${args.amount}`,
      execute: async (args) => {
        executeCount.n += 1;
        if (shouldHang) {
          hangStarted = true;
          await new Promise<void>((resolve) => {
            releaseHang = resolve;
          });
        }
        const key = `charge:${args.amount}`;
        if (!seen.has(key)) {
          seen.add(key);
          sideEffects.n += 1;
        }
        return { charged: true, n: sideEffects.n };
      },
    });
    const node = action({
      id: 'charge',
      run: async (_state, ctx) => {
        await ctx.tool('charge', { amount: 10 });
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'charge-once',
      description: 'Charge once',
      start: node,
      nodes: [node],
    });
    const agent = defineAgent({
      id: defaultAgentId,
      model: stubModel,
      flows: [flow],
      tools: { charge },
    });
    const harness = {
      agents: [agent],
      defaultAgentId,
      sessionStore,
      defaultModel: stubModel,
    };
    const crashed = createRuntime(harness);
    const handle = crashed.run({
      sessionId,
      kind: 'flow',
      flowName: 'charge-once',
      driver: noopDriver(),
    });

    const deadline = Date.now() + 5_000;
    while (!hangStarted && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(hangStarted).toBe(true);

    const inner = new SessionRunStore(sessionStore, sessionId);
    const running: string[] = [];
    for await (const ref of inner.listRuns({ status: 'running' })) {
      running.push(ref.runId);
    }
    expect(running).toHaveLength(1);
    const runId = running[0]!;
    const stepsMid = await inner.getSteps(runId);
    expect(stepsMid.some((step) => step.name === 'charge' && step.status === 'running')).toBe(true);

    const mid = await inner.getRunState(runId);
    expect(mid?.status).toBe('running');
    mid!.leaseExpiresAt = Date.now() - 1;
    await inner.putRunState(mid!);

    // Observed red: without recoverOrphanedRuns the run stays `running` forever.
    expect((await inner.getRunState(runId))?.status).toBe('running');

    shouldHang = false;
    const recoveredRuntime = createRuntime(harness);
    const report = await recoverOrphanedRuns(recoveredRuntime);
    expect(report.recovered.map((ref) => ref.runId)).toEqual([runId]);

    const finished = await inner.getRunState(runId);
    expect(finished?.activeFlow).toBeUndefined();
    expect(sideEffects.n).toBe(1);
    const steps = await inner.getSteps(runId);
    expect(steps.find((step) => step.name === 'charge')?.status).toBe('finished');

    releaseHang?.();
    await handle;
  });

  it('does not recover a run with a fresh lease (skippedLive)', async () => {
    const sessionId = 'live-lease-sess';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const journal = new SessionRunStore(sessionStore, sessionId);
    const now = Date.now();
    await journal.initRun({
      runId: 'live-run',
      sessionId,
      kind: 'flow',
      status: 'running',
      activeAgentId: defaultAgentId,
      state: {},
      messages: [],
      createdAt: now,
      updatedAt: now,
      leaseHolder: 'replica-a',
      leaseExpiresAt: now + 60_000,
    });

    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore,
      defaultModel: stubModel,
    });
    const report = await recoverOrphanedRuns(runtime);
    expect(report.skippedLive).toBe(1);
    expect(report.recovered).toEqual([]);
    expect((await journal.getRunState('live-run'))?.status).toBe('running');
  });
});

describe('sweepDeadlines', () => {
  it('delivers a deny on a past deadline and leaves a future deadline untouched', async () => {
    const sessionStore = new MemoryStore();
    const outcomes: Array<{ approved?: boolean; reason?: string }> = [];
    const past = action({
      id: 'past',
      run: async (_state, ctx) => {
        const result = (await ctx.signal('continue', {
          schema: z.object({}).strict(),
          deadline: Date.now() - 5_000,
        })) as { approved?: boolean; reason?: string };
        outcomes.push(result);
        return { end: result.approved === false ? 'denied' : 'ok' };
      },
    });
    const future = action({
      id: 'future',
      run: async (_state, ctx) => {
        await ctx.signal('continue', {
          schema: z.object({}).strict(),
          deadline: Date.now() + 60_000,
        });
        return { end: 'ok' };
      },
    });
    const pastFlow = defineFlow({
      name: 'past-deadline',
      description: 'd',
      start: past,
      nodes: [past],
    });
    const futureFlow = defineFlow({
      name: 'future-deadline',
      description: 'd',
      start: future,
      nodes: [future],
    });
    const agent = defineAgent({
      id: defaultAgentId,
      model: stubModel,
      flows: [pastFlow, futureFlow],
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId,
      sessionStore,
      defaultModel: stubModel,
    });
    const driver = noopDriver();

    await runtime.run({
      sessionId: 'past-sess',
      kind: 'flow',
      flowName: 'past-deadline',
      driver,
    });
    await runtime.run({
      sessionId: 'future-sess',
      kind: 'flow',
      flowName: 'future-deadline',
      driver,
    });

    const pastStore = new SessionRunStore(sessionStore, 'past-sess');
    const futureStore = new SessionRunStore(sessionStore, 'future-sess');
    let pastRunId = '';
    let futureRunId = '';
    for await (const ref of pastStore.listRuns({ status: 'paused' })) {
      if (ref.flowName === 'past-deadline') pastRunId = ref.runId;
      if (ref.flowName === 'future-deadline') futureRunId = ref.runId;
    }
    expect(pastRunId).not.toBe('');
    expect(futureRunId).not.toBe('');

    const delivered = await sweepDeadlines(runtime);
    expect(delivered.map((ref) => ref.runId)).toEqual([pastRunId]);

    expect((await pastStore.getRunState(pastRunId))?.waitingFor).toBeUndefined();
    expect((await pastStore.getRunState(pastRunId))?.activeFlow).toBeUndefined();
    expect((await futureStore.getRunState(futureRunId))?.status).toBe('paused');
    expect((await futureStore.getRunState(futureRunId))?.waitingFor?.signalName).toBe('continue');
    expect(outcomes[0]).toMatchObject({
      approved: false,
      reason: DEADLINE_EXPIRED_REASON,
    });
  });
});

describe('deadline-expired signal path', () => {
  it('rejects a late user delivery and accepts a system deadline-expired deny', async () => {
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor: { execute: async () => ({}), getTool: () => undefined },
    });
    await expect(
      ctx.signal('continue', {
        schema: z.object({}).strict(),
        deadline: Date.now() - 1_000,
      }),
    ).rejects.toBeInstanceOf(SuspendError);

    const paused = (await runStore.getRunState(runState.runId))!;
    await expect(
      recordSignalDelivery(runStore, paused, {
        signalId: 'late-user',
        requestId: paused.waitingFor!.requestId,
        name: 'continue',
        actor: { id: 'user-1', type: 'user' },
        payload: {},
      }),
    ).rejects.toThrow('expired before delivery');

    const recorded = await recordSignalDelivery(
      runStore,
      paused,
      deadlineExpiryDelivery(paused.waitingFor!),
    );
    expect(recorded).toBe(true);
    const steps = await runStore.getSteps(runState.runId);
    expect(steps[0]?.result).toMatchObject({
      approved: false,
      reason: DEADLINE_EXPIRED_REASON,
    });
  });
});

describe('sweep scheduler', () => {
  it('startRunSweeper enqueues a sweep job the runner executes', async () => {
    let fires = 0;
    const runtime = {
      run: () => {
        throw new Error('run should not be called with an empty store');
      },
      getRunStore: () => ({
        async *listRuns() {},
        async deleteRun() {},
        async appendStep() {},
        async finalizeStep() {},
        async getSteps() {
          return [];
        },
        async getRunState() {
          return null;
        },
        async putRunState() {},
      }),
    };
    let fire: (() => void) | undefined;
    const scheduler = createInProcessScheduler({
      run: async (job) => {
        expect(isSweepJob(job)).toBe(true);
        expect(job.kind).toBe(SWEEP_JOB_KIND);
        fires += 1;
        await createSweepJobRunner(runtime)(job);
      },
      timer: {
        set: (fn) => {
          fire = fn;
          return 1;
        },
        clear: () => {},
      },
    });

    await startRunSweeper(scheduler, { intervalMs: 1_000, delayMs: 1_000 });
    expect(fires).toBe(0);
    fire!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fires).toBe(1);
  });

  it('sweepJob is identifiable', () => {
    expect(isSweepJob(sweepJob())).toBe(true);
    expect(isSweepJob({ kind: 'other', payload: {} })).toBe(false);
  });
});

describe('isRunLeaseStale', () => {
  it('treats missing and past leases as stale and a future lease as live', () => {
    const now = 1_700_000_000_000;
    expect(isRunLeaseStale(undefined, now)).toBe(false);
    expect(isRunLeaseStale(now - 1, now)).toBe(true);
    expect(isRunLeaseStale(now + 1, now)).toBe(false);
  });
});
