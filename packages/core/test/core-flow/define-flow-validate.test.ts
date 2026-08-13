import { describe, expect, it } from 'bun:test';
import { action, confirmGate, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

describe('defineFlow structure validation', () => {
  it('defineFlow-rejects-inline-target', () => {
    const ask = confirmGate({
      id: 'ask',
      instructions: 'Proceed?',
      onConfirm: reply({ id: 'secret', instructions: 'inline' }),
      onDecline: { end: 'declined' },
    });
    expect(() =>
      defineFlow({
        name: 'inline-target',
        description: '',
        start: ask,
        nodes: [ask],
      }),
    ).toThrow(
      /\[inline-transition-target\] nodes\.0\.confirmGate\.onConfirm:[\s\S]*secret[\s\S]*flow\.nodes/,
    );
  });

  it('defineFlow-rejects-dangling-goto', () => {
    const ask = confirmGate({
      id: 'ask',
      instructions: 'Proceed?',
      onConfirm: { goto: 'nope' },
      onDecline: { end: 'declined' },
    });
    expect(() =>
      defineFlow({
        name: 'dangling-goto',
        description: '',
        start: ask,
        nodes: [ask],
      }),
    ).toThrow(
      /\[unresolved-transition\] nodes\.0\.confirmGate\.onConfirm:[\s\S]*nope/,
    );
  });

  it('rejects duplicate node ids with the structure path', () => {
    const a = reply({ id: 'a', instructions: 'A', next: () => ({ end: 'done' }) });
    const dup = reply({ id: 'a', instructions: 'dup', next: () => ({ end: 'done' }) });
    expect(() =>
      defineFlow({
        name: 'dup-ids',
        description: '',
        start: a,
        nodes: [a, dup],
      }),
    ).toThrow(/\[duplicate-node-id\] nodes\.1\.id/);
  });

  it('rejects a start id that is not in nodes', () => {
    const a = reply({ id: 'a', instructions: 'A', next: () => ({ end: 'done' }) });
    const missing = reply({ id: 'missing', instructions: 'M', next: () => ({ end: 'done' }) });
    expect(() =>
      defineFlow({
        name: 'missing-start',
        description: '',
        start: missing,
        nodes: [a],
      }),
    ).toThrow(/\[missing-start\] start/);
  });

  it('rejects a start object that is not the registered member with that id', () => {
    const a = reply({ id: 'a', instructions: 'A', next: () => ({ end: 'done' }) });
    const other = reply({ id: 'a', instructions: 'other', next: () => ({ end: 'done' }) });
    expect(() =>
      defineFlow({
        name: 'start-not-member',
        description: '',
        start: other,
        nodes: [a],
      }),
    ).toThrow(/\[missing-start\] start/);
  });

  it('rejects an unreachable registered node when start has no opaque successor', () => {
    const start = reply({ id: 'start', instructions: 'terminal' });
    const orphan = reply({ id: 'orphan', instructions: 'unused', next: () => ({ end: 'done' }) });
    expect(() =>
      defineFlow({
        name: 'orphan-flow',
        description: '',
        start,
        nodes: [start, orphan],
      }),
    ).toThrow(/\[unreachable-node\] nodes\.1/);
  });

  it('accepts a registered node reference and a goto id', () => {
    const done = reply({ id: 'done', instructions: 'Done', next: () => ({ end: 'ok' }) });
    const ask = confirmGate({
      id: 'ask',
      instructions: 'Proceed?',
      onConfirm: done,
      onDecline: { goto: 'done' },
    });
    const flow = defineFlow({
      name: 'ok',
      description: '',
      start: ask,
      nodes: [ask, done],
    });
    expect(flow.nodes).toHaveLength(2);
  });
});

describe('runFlow rejects unregistered goto targets', () => {
  it('throws when a closure returns a node that is not in flow.nodes', async () => {
    const start = action({
      id: 'start',
      run: () => reply({ id: 'ghost', instructions: 'nope', next: () => ({ end: 'x' }) }),
    });
    const flow = defineFlow({
      name: 'ghost-flow',
      description: '',
      start,
      nodes: [start],
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('ghost-sess', 'ghost-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toThrow(/ghost/);
  });
});
