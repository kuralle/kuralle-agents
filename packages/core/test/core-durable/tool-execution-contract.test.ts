import { describe, expect, it } from 'bun:test';
import type { StreamPart } from '../../src/types/stream.js';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import { ToolTimeoutError } from '../../src/tools/effect/errors.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import { dispatchModelToolCalls } from '../../src/runtime/channels/executeModelTool.js';
import { recordSignalDelivery } from '../../src/runtime/durable/replay.js';
import { buildCtx, reloadRunState, setupDurableHarness } from './helpers.js';

const APPROVAL_SIGNAL = '__approval';

describe('control-flow signals are not tool failures', () => {
  it('pauses the run when the model calls a needsApproval tool', async () => {
    const harness = await setupDurableHarness('approval-sess', 'approval-run');
    let refunds = 0;
    const tools = {
      issue_refund: {
        name: 'issue_refund',
        description: 'Issue a refund',
        needsApproval: true,
        execute: async () => {
          refunds += 1;
          return { refunded: true };
        },
      },
    };

    const emitted: StreamPart[] = [];
    const ctx = await buildCtx({
      ...harness,
      toolExecutor: new CoreToolExecutor({ tools }),
      emit: (part) => emitted.push(part),
    });

    const delivered: unknown[] = [];
    const call = { toolName: 'issue_refund', input: { id: 'a' }, toolCallId: 'c1' };

    // The suspend must reach the caller. Previously it was caught and handed to the model as
    // a tool error, so the turn continued while the store said the run was paused.
    await expect(
      dispatchModelToolCalls(ctx, [call], tools, ({ outcome }) => delivered.push(outcome.result)),
    ).rejects.toBeInstanceOf(SuspendError);

    expect(refunds).toBe(0);
    // Nothing may reach the transcript: there is no result yet, only a pending decision.
    expect(delivered).toEqual([]);
    expect(emitted.filter((p) => p.type === 'error')).toEqual([]);
    expect(emitted.some((p) => p.type === 'paused')).toBe(true);

    const paused = await harness.runStore.getRunState('approval-run');
    expect(paused?.status).toBe('paused');
    expect(paused?.waitingFor?.signalName).toBe(APPROVAL_SIGNAL);
  });

  it('runs the tool exactly once after approval is granted', async () => {
    const harness = await setupDurableHarness('approve-sess', 'approve-run');
    let refunds = 0;
    const tools = {
      issue_refund: {
        name: 'issue_refund',
        description: 'Issue a refund',
        needsApproval: true,
        execute: async () => {
          refunds += 1;
          return { refunded: true };
        },
      },
    };
    const call = { toolName: 'issue_refund', input: { id: 'a' }, toolCallId: 'c1' };

    const ctx = await buildCtx({ ...harness, toolExecutor: new CoreToolExecutor({ tools }) });
    await expect(
      dispatchModelToolCalls(ctx, [call], tools, () => {}),
    ).rejects.toBeInstanceOf(SuspendError);

    const resumedState = await reloadRunState(harness.runStore, 'approve-run');
    await recordSignalDelivery(harness.runStore, resumedState, {
      signalId: 'sig-1',
      requestId: resumedState.waitingFor!.requestId,
      name: APPROVAL_SIGNAL,
      actor: { id: 'supervisor', type: 'user' },
      decision: 'approve',
    });

    const results: unknown[] = [];
    const resumedCtx = await buildCtx({
      ...harness,
      runState: resumedState,
      toolExecutor: new CoreToolExecutor({ tools }),
    });
    await dispatchModelToolCalls(resumedCtx, [call], tools, ({ outcome }) =>
      results.push(outcome.result),
    );

    expect(refunds).toBe(1);
    expect(results).toEqual([{ refunded: true }]);
  });

  it('tells the model when a human denies a tool it asked to run', async () => {
    const harness = await setupDurableHarness('deny-sess', 'deny-run');
    let refunds = 0;
    const tools = {
      issue_refund: {
        name: 'issue_refund',
        description: 'Issue a refund',
        needsApproval: true,
        execute: async () => {
          refunds += 1;
          return { refunded: true };
        },
      },
    };
    const call = { toolName: 'issue_refund', input: { id: 'a' }, toolCallId: 'c1' };

    const ctx = await buildCtx({ ...harness, toolExecutor: new CoreToolExecutor({ tools }) });
    await expect(
      dispatchModelToolCalls(ctx, [call], tools, () => {}),
    ).rejects.toBeInstanceOf(SuspendError);

    const resumed = await reloadRunState(harness.runStore, 'deny-run');
    await recordSignalDelivery(harness.runStore, resumed, {
      signalId: 'sig-deny',
      requestId: resumed.waitingFor!.requestId,
      name: APPROVAL_SIGNAL,
      actor: { id: 'supervisor', type: 'user' },
      decision: 'deny',
    });

    const emitted: StreamPart[] = [];
    const delivered: unknown[] = [];
    const resumedCtx = await buildCtx({
      ...harness,
      runState: resumed,
      toolExecutor: new CoreToolExecutor({ tools }),
      emit: (part) => emitted.push(part),
    });

    // A denial is a decision, not a suspend and not a malfunction. The turn must survive it:
    // the model asked for this call, so the model is told, and the agent can tell the user.
    await dispatchModelToolCalls(resumedCtx, [call], tools, ({ outcome }) =>
      delivered.push(outcome.result),
    );

    expect(refunds).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      __denied: true,
      toolName: 'issue_refund',
      deniedBy: 'supervisor',
    });
    // Nothing broke, so nothing may be reported to the user as an error.
    expect(emitted.filter((p) => p.type === 'error')).toEqual([]);
  });

  it('still finalizes sibling effects when one call in a parallel batch suspends', async () => {
    const harness = await setupDurableHarness('par-sess', 'par-run');
    let siblingRuns = 0;
    const tools = {
      sibling: {
        name: 'sibling',
        description: 'Ordinary parallel-safe tool',
        parallelSafe: true,
        execute: async () => {
          siblingRuns += 1;
          return { ok: true };
        },
      },
      gated: {
        name: 'gated',
        description: 'Needs approval',
        parallelSafe: true,
        needsApproval: true,
        execute: async () => ({ gated: true }),
      },
    };

    const ctx = await buildCtx({ ...harness, toolExecutor: new CoreToolExecutor({ tools }) });
    await expect(
      dispatchModelToolCalls(
        ctx,
        [
          { toolName: 'sibling', input: {}, toolCallId: 'c1' },
          { toolName: 'gated', input: {}, toolCallId: 'c2' },
        ],
        tools,
        () => {},
      ),
    ).rejects.toBeInstanceOf(SuspendError);

    // The suspend propagates only after the batch settles — an abandoned sibling would leave
    // its step 'running' and re-execute on resume.
    expect(siblingRuns).toBe(1);
    const steps = await harness.runStore.getSteps('par-run');
    const sibling = steps.find((s) => s.name === 'sibling');
    expect(sibling?.status).toBe('finished');
  });
});

describe('tool timeout', () => {
  it('aborts the tool rather than abandoning it still running', async () => {
    let observedAbort = false;
    let finishedAnyway = false;
    const executor = new CoreToolExecutor({
      tools: {
        slow: {
          name: 'slow',
          description: 'Never finishes on its own',
          timeoutMs: 20,
          execute: async (_args: unknown, toolCtx?: { abortSignal?: AbortSignal }) =>
            new Promise((resolve) => {
              toolCtx?.abortSignal?.addEventListener('abort', () => {
                observedAbort = true;
                resolve({ cancelled: true });
              });
              setTimeout(() => {
                finishedAnyway = true;
                resolve({ cancelled: false });
              }, 2000).unref?.();
            }),
        },
      },
    });

    await expect(
      executor.execute({ name: 'slow', args: {}, session: {} as never }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);

    expect(observedAbort).toBe(true);
    expect(finishedAnyway).toBe(false);
  });
});

describe('per-tool error recovery', () => {
  it('turns a thrown error into a result the model can act on', async () => {
    const executor = new CoreToolExecutor({
      tools: {
        flaky: {
          name: 'flaky',
          description: 'Throws',
          execute: async () => {
            throw new Error('upstream 503');
          },
          onError: (error: Error) => ({ ok: false, reason: error.message }),
        },
      },
    });

    const result = await executor.execute({ name: 'flaky', args: {}, session: {} as never });
    expect(result).toEqual({ ok: false, reason: 'upstream 503' });
  });

  it('does not let a tool reinterpret its own timeout', async () => {
    let onErrorCalled = false;
    const executor = new CoreToolExecutor({
      tools: {
        slow: {
          name: 'slow',
          description: 'Times out',
          timeoutMs: 10,
          execute: () => new Promise(() => {}),
          onError: () => {
            onErrorCalled = true;
            return { swallowed: true };
          },
        },
      },
    });

    await expect(
      executor.execute({ name: 'slow', args: {}, session: {} as never }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(onErrorCalled).toBe(false);
  });
});

describe('streaming tool output', () => {
  it('emits each chunk as it arrives and still returns the aggregate', async () => {
    const chunks: unknown[] = [];
    const executor = new CoreToolExecutor({
      tools: {
        streamer: {
          name: 'streamer',
          description: 'Yields progress',
          execute: async function* () {
            yield { step: 1 };
            yield { step: 2 };
            yield { step: 3 };
          },
        },
      },
      onChunk: (chunk) => chunks.push(chunk),
    });

    const result = await executor.execute({ name: 'streamer', args: {}, session: {} as never });
    expect(chunks).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
    expect(result).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
  });
});

describe('parallel tool concurrency ceiling', () => {
  it('never exceeds limits.maxToolConcurrency in flight', async () => {
    const harness = await setupDurableHarness('conc-sess', 'conc-run');
    let inFlight = 0;
    let peak = 0;
    const makeTool = (name: string) => ({
      name,
      description: name,
      parallelSafe: true,
      execute: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { name };
      },
    });
    const names = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const tools = Object.fromEntries(names.map((n) => [n, makeTool(n)]));

    const ctx = await buildCtx({ ...harness, toolExecutor: new CoreToolExecutor({ tools }) });
    ctx.limits = { maxToolConcurrency: 2 };

    const done: unknown[] = [];
    await dispatchModelToolCalls(
      ctx,
      names.map((n, i) => ({ toolName: n, input: {}, toolCallId: `c${i}` })),
      tools,
      ({ outcome }) => done.push(outcome.result),
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(done).toHaveLength(names.length);
  });
});
