import { describe, expect, it } from 'bun:test';
import type { ValidationCapability } from '../../src/capabilities/ValidationCapability.js';
import type { ResolvedNode } from '../../src/types/channel.js';
import { action, type FlowNode } from '../../src/types/flow.js';
import type { OutputProcessor } from '../../src/types/processors.js';
import type { RunContext } from '../../src/types/run-context.js';
import { resolveStreamMode } from '../../src/runtime/channels/streaming/mode.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import {
  makeRunState,
  makeTestSession,
  stubModel,
} from '../core-durable/helpers.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';

function makeResolvedNode(node: FlowNode): ResolvedNode {
  return { node, prompt: '', tools: {} };
}

async function makeCtx(overrides: {
  outputProcessors?: OutputProcessor[];
  validationPolicies?: ValidationCapability[];
}): Promise<RunContext> {
  const session = makeTestSession('mode-test');
  const memoryStore = new MemoryStore();
  await memoryStore.save(session);
  const runStore = new SessionRunStore(memoryStore, session.id);
  const runState = makeRunState(session.id, 'mode-run');
  await runStore.initRun(runState);
  return createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    outputProcessors: overrides.outputProcessors,
    validationPolicies: overrides.validationPolicies,
  });
}

const sentencePolicy: ValidationCapability = {
  name: 'sentence-policy',
  streamGranularity: 'sentence',
  validate: async () => ({ decision: 'continue', confidence: 1 }),
};

const turnPolicy: ValidationCapability = {
  name: 'turn-policy',
  streamGranularity: 'turn',
  validate: async () => ({ decision: 'continue', confidence: 1 }),
};

const defaultPolicy: ValidationCapability = {
  name: 'default-policy',
  validate: async () => ({ decision: 'continue', confidence: 1 }),
};

const sentenceProcessor: OutputProcessor = {
  id: 'sentence-processor',
  streamGranularity: 'sentence',
  process: () => ({ action: 'allow' }),
};

const turnProcessor: OutputProcessor = {
  id: 'turn-processor',
  streamGranularity: 'turn',
  process: () => ({ action: 'allow' }),
};

const defaultProcessor: OutputProcessor = {
  id: 'default-processor',
  process: () => ({ action: 'allow' }),
};

describe('resolveStreamMode', () => {
  it('returns token when no gates and no confidenceGate', async () => {
    const ctx = await makeCtx({});
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('token');
  });

  it('returns sentence for a single sentence validation policy', async () => {
    const ctx = await makeCtx({ validationPolicies: [sentencePolicy] });
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('sentence');
  });

  it('returns sentence for a single sentence output processor', async () => {
    const ctx = await makeCtx({ outputProcessors: [sentenceProcessor] });
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('sentence');
  });

  it('returns turn for an explicit turn validation policy', async () => {
    const ctx = await makeCtx({ validationPolicies: [turnPolicy] });
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('turn');
  });

  it('returns turn when streamGranularity is undeclared (REQ-5 default)', async () => {
    const ctx = await makeCtx({ validationPolicies: [defaultPolicy] });
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('turn');
  });

  it('returns turn when streamGranularity is undeclared on an output processor', async () => {
    const ctx = await makeCtx({ outputProcessors: [defaultProcessor] });
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('turn');
  });

  it('coarsest wins: sentence processor plus turn policy yields turn', async () => {
    const ctx = await makeCtx({
      outputProcessors: [sentenceProcessor],
      validationPolicies: [turnPolicy],
    });
    const node = makeResolvedNode({ kind: 'reply', id: 'r1', instructions: 'hi' });
    expect(resolveStreamMode(ctx, node)).toBe('turn');
  });

  it('returns turn for reply node with confidenceGate and zero processors', async () => {
    const ctx = await makeCtx({});
    const node = makeResolvedNode({
      kind: 'reply',
      id: 'r1',
      instructions: 'hi',
      confidenceGate: { min: 0.8, onLow: 'stay' },
    });
    expect(resolveStreamMode(ctx, node)).toBe('turn');
  });

  it('returns token for reply with grounding only (no confidenceGate)', async () => {
    const ctx = await makeCtx({});
    const node = makeResolvedNode({
      kind: 'reply',
      id: 'r1',
      instructions: 'hi',
      grounding: { query: 'product docs' },
    });
    expect(resolveStreamMode(ctx, node)).toBe('token');
  });

  it('returns token for non-reply nodes with zero gates', async () => {
    const ctx = await makeCtx({});
    const node = makeResolvedNode(action({ id: 'a1', run: () => 'stay' }));
    expect(resolveStreamMode(ctx, node)).toBe('token');
  });
});
