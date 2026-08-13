import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { action, defineFlow } from '../../src/types/flow.js';
import type { StreamPart } from '../../src/types/stream.js';
import type { FlowGateJudgeProvider } from '../../src/flow/evaluateGates.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

function spyDriver() {
  return {
    async runAgentTurn() {
      return { text: '', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message' as const, input: '' };
    },
  };
}

async function runGatedFlow(args: {
  flow: ReturnType<typeof defineFlow>;
  sessionId: string;
  judge?: FlowGateJudgeProvider;
}): Promise<{ parts: StreamPart[]; result: Awaited<ReturnType<typeof runFlow>>; runState: import('../../src/runtime/durable/types.js').RunState }> {
  const { session, runStore, runState } = await setupDurableHarness(args.sessionId, args.sessionId);
  const parts: StreamPart[] = [];
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (part) => parts.push(part),
    flowGateJudge: args.judge,
  });
  const result = await runFlow(args.flow, runState, spyDriver(), ctx);
  return { parts, result, runState };
}

function blockingStatusFlow() {
  const finish = action({
    id: 'finish',
    run: (state) => {
      state.status = 'bad';
      return { end: 'done' };
    },
  });
  return defineFlow({
    name: 'gated-status',
    description: '',
    start: finish,
    nodes: [finish],
    gates: [
      {
        id: 'status-ok',
        kind: 'predicate',
        severity: 'blocking',
        when: { op: 'eq', left: { path: 'state.status' }, right: { literal: 'ok' } },
      },
    ],
  });
}

describe('flow verification gates', () => {
  it('blocking predicate failure records failed-verification, verdicts, and still emits flow-end', async () => {
    const { parts, result, runState } = await runGatedFlow({
      flow: blockingStatusFlow(),
      sessionId: 'gate-blocking-pred',
    });

    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(runState.verification?.outcome).toBe('failed-verification');
    expect(runState.verification?.verdicts).toEqual([
      {
        id: 'status-ok',
        kind: 'predicate',
        severity: 'blocking',
        passed: false,
      },
    ]);
    const end = parts.find((part) => part.type === 'flow-end');
    expect(end).toBeDefined();
    expect(end?.type === 'flow-end' && end.payload.reason).toBe('done');
    expect(end?.type === 'flow-end' && end.payload.outcome).toBe('failed-verification');
    expect(end?.type === 'flow-end' && end.payload.gates).toEqual(runState.verification?.verdicts);
  });

  it('advisory predicate failure records the verdict and leaves the outcome unchanged', async () => {
    const finish = action({
      id: 'finish',
      run: (state) => {
        state.status = 'bad';
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'gated-advisory',
      description: '',
      start: finish,
      nodes: [finish],
      gates: [
        {
          id: 'status-ok',
          kind: 'predicate',
          severity: 'advisory',
          when: { op: 'eq', left: { path: 'state.status' }, right: { literal: 'ok' } },
        },
      ],
    });

    const { parts, result, runState } = await runGatedFlow({
      flow,
      sessionId: 'gate-advisory-pred',
    });

    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(runState.verification?.outcome).toBe('passed');
    expect(runState.verification?.verdicts).toEqual([
      {
        id: 'status-ok',
        kind: 'predicate',
        severity: 'advisory',
        passed: false,
      },
    ]);
    const end = parts.find((part) => part.type === 'flow-end');
    expect(end?.type === 'flow-end' && end.payload.outcome).toBeUndefined();
    expect(end?.type === 'flow-end' && end.payload.gates).toEqual(runState.verification?.verdicts);
  });

  it('a judge whose provider throws is blocking even when declared advisory', async () => {
    const finish = action({
      id: 'finish',
      run: () => ({ end: 'done' }),
    });
    const flow = defineFlow({
      name: 'gated-judge-throw',
      description: '',
      start: finish,
      nodes: [finish],
      gates: [
        {
          id: 'quality',
          kind: 'judge',
          severity: 'advisory',
          inputs: ['state.status'],
          rubric: 'status is acceptable',
        },
      ],
    });
    const judge: FlowGateJudgeProvider = {
      modelId: 'spy',
      async judge() {
        throw new Error('judge-down');
      },
    };

    const { parts, runState } = await runGatedFlow({
      flow,
      sessionId: 'gate-judge-throw',
      judge,
    });

    expect(runState.verification?.outcome).toBe('failed-verification');
    expect(runState.verification?.verdicts[0]?.executionError).toBe(true);
    expect(runState.verification?.verdicts[0]?.severity).toBe('advisory');
    expect(runState.verification?.verdicts[0]?.passed).toBe(false);
    const end = parts.find((part) => part.type === 'flow-end');
    expect(end?.type === 'flow-end' && end.payload.outcome).toBe('failed-verification');
  });

  it('a judge structured call receives only the allow-listed paths', async () => {
    const seen: Record<string, unknown>[] = [];
    const finish = action({
      id: 'finish',
      run: (state) => {
        state.amount = 10;
        state.secret = 'nope';
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'gated-judge-scope',
      description: '',
      start: finish,
      nodes: [finish],
      gates: [
        {
          id: 'amount-ok',
          kind: 'judge',
          severity: 'blocking',
          inputs: ['state.amount'],
          rubric: 'amount is present',
        },
      ],
    });
    const judge: FlowGateJudgeProvider = {
      modelId: 'spy',
      async judge({ payload }) {
        seen.push(payload);
        return { pass: true };
      },
    };

    const { runState } = await runGatedFlow({
      flow,
      sessionId: 'gate-judge-scope',
      judge,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ state: { amount: 10 } });
    expect(seen[0]?.state).not.toHaveProperty('secret');
    expect(runState.verification?.outcome).toBe('passed');
  });

  it('Runtime marks conversation outcome failed-verification on a blocking gate', async () => {
    const finish = action({
      id: 'finish',
      run: (state) => {
        state.status = 'bad';
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'runtime-gated',
      description: '',
      start: finish,
      nodes: [finish],
      gates: [
        {
          id: 'status-ok',
          kind: 'predicate',
          severity: 'blocking',
          when: { op: 'eq', left: { path: 'state.status' }, right: { literal: 'ok' } },
        },
      ],
    });
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [
        defineAgent({
          id: 'clerk',
          instructions: 'Help.',
          model: stubModel,
          flows: [flow],
        }),
      ],
      defaultAgentId: 'clerk',
      sessionStore,
    });

    const parts: StreamPart[] = [];
    const handle = runtime.run({
      sessionId: 'gate-runtime-mark',
      kind: 'flow',
      flowName: 'runtime-gated',
      input: 'go',
    });
    for await (const part of handle.events) {
      parts.push(part);
    }
    await handle;

    const session = await runtime.getSession('gate-runtime-mark');
    expect(session?.metadata?.outcome?.outcome).toBe('failed-verification');
    expect(session?.metadata?.outcome?.gates?.[0]?.id).toBe('status-ok');
    expect(parts.some((part) => part.type === 'flow-end')).toBe(true);
    expect(parts.some((part) => part.type === 'conversation-outcome' && part.payload.outcome === 'failed-verification')).toBe(
      true,
    );
    expect(session?.metadata?.audit?.some((entry) => entry.type === 'outcome-marked' && entry.outcome === 'failed-verification')).toBe(
      true,
    );
  });
});
