import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../src/types/flow.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { classifyHostTarget } from '../../src/runtime/select.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { StreamPart } from '../../src/types/stream.js';
import { mockV3GenerateObjectModel } from '../helpers/mockLanguageModelV3Results.js';

function pureDispatcherAgent(model = stubModel) {
  return defineAgent({
    id: 'router',
    routes: [
      { agent: 'billing', when: 'billing or payment questions' },
      { agent: 'support', when: 'general support questions' },
      { agent: 'sales', when: 'sales and pricing inquiries' },
    ],
    routing: { model },
    model: stubModel,
  });
}

function classifierFallbackEvents(parts: StreamPart[]) {
  return parts.filter(
    (part): part is Extract<StreamPart, { type: 'custom' }> =>
      part.type === 'custom' && part.payload.name === 'classifier-fallback',
  );
}

describe('pure dispatcher classifier fallback', () => {
  it('falls back to the first declared route when the classifier returns an unusable pick', async () => {
    const model = mockV3GenerateObjectModel(async () => ({
      object: {
        action: 'transfer',
        flowName: null,
        agentId: 'nonexistent-agent',
        reason: 'guess',
      },
    }));
    const agent = pureDispatcherAgent(model);

    let agentTurns = 0;
    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        agentTurns += 1;
        return { text: 'should not run', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness(
      'dispatcher-fallback-invalid',
      'dispatcher-fallback-invalid',
    );
    runState.messages = [{ role: 'user', content: 'something ambiguous' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: (part) => parts.push(part),
    });

    const result = await hostLoop({ agent, run: runState, driver, ctx });
    expect(result).toEqual({ kind: 'handoff', to: 'billing', reason: 'classifier-fallback' });
    expect(agentTurns).toBe(0);
    expect(classifierFallbackEvents(parts)).toHaveLength(1);
    expect(classifierFallbackEvents(parts)[0]?.payload.data).toMatchObject({
      reason: 'invalid-pick',
      action: 'transfer',
      targetAgentId: 'billing',
    });
  });

  it('falls back to the first declared route when the classifier throws', async () => {
    const model = mockV3GenerateObjectModel(async () => {
      throw new Error('NoObjectGeneratedError');
    });
    const agent = pureDispatcherAgent(model);

    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness(
      'dispatcher-fallback-throw',
      'dispatcher-fallback-throw',
    );
    runState.messages = [{ role: 'user', content: 'something ambiguous' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: (part) => parts.push(part),
    });

    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        return { text: 'should not run', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const result = await hostLoop({ agent, run: runState, driver, ctx });
    expect(result).toEqual({ kind: 'handoff', to: 'billing', reason: 'classifier-fallback' });
    expect(classifierFallbackEvents(parts)).toHaveLength(1);
    expect(classifierFallbackEvents(parts)[0]?.payload.data).toMatchObject({
      reason: 'model-error',
      action: 'transfer',
      targetAgentId: 'billing',
    });
  });

  it('falls back to the first declared flow route when route 1 targets a flow', async () => {
    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const intake = defineFlow({
      name: 'intake',
      description: 'Collect intake details',
      start: end,
      nodes: [end],
    });
    const faq = defineFlow({
      name: 'faq',
      description: 'Answer FAQs',
      start: end,
      nodes: [end],
    });
    const model = mockV3GenerateObjectModel(async () => ({
      object: {
        action: 'enterFlow',
        flowName: 'missing-flow',
        agentId: null,
        reason: 'guess',
      },
    }));
    const agent = defineAgent({
      id: 'router',
      flows: [intake, faq],
      routes: [
        { flow: 'intake', when: 'start intake' },
        { agent: 'support', when: 'general support' },
        { agent: 'sales', when: 'sales inquiries' },
      ],
      routing: { model },
      model: stubModel,
    });

    const parts: StreamPart[] = [];
    const { runState } = await setupDurableHarness(
      'dispatcher-fallback-flow',
      'dispatcher-fallback-flow',
    );
    runState.messages = [{ role: 'user', content: 'help me' }];

    const verdict = await classifyHostTarget({
      agent,
      run: runState,
      model,
      allowKeep: false,
      emit: (part) => parts.push(part),
    });

    expect(verdict).toMatchObject({
      action: 'enterFlow',
      flowName: 'intake',
      reason: 'classifier-fallback',
    });
    expect(classifierFallbackEvents(parts)[0]?.payload.data).toMatchObject({
      reason: 'invalid-pick',
      action: 'enterFlow',
      flowName: 'intake',
    });
  });

  it('answering-agent guard still keeps on an invalid verdict (allowKeep: true)', async () => {
    const agent = defineAgent({
      id: 'host',
      instructions: 'Route internally',
      routes: [
        { agent: 'billing', when: 'billing' },
        { agent: 'support', when: 'support' },
      ],
      model: stubModel,
    });

    const model = mockV3GenerateObjectModel(async () => ({
      object: {
        action: 'transfer',
        flowName: null,
        agentId: 'nonexistent-agent',
        reason: 'guess',
        confidence: 0.2,
      },
    }));

    const { runState } = await setupDurableHarness('guard-keep', 'guard-keep');
    runState.messages = [{ role: 'user', content: 'hello' }];

    const verdict = await classifyHostTarget({
      agent,
      run: runState,
      model,
      allowKeep: true,
    });

    expect(verdict.action).toBe('keep');
  });

  it('an aborted classifier call propagates instead of falling back (allowKeep: false)', async () => {
    const model = mockV3GenerateObjectModel(async () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      throw error;
    });
    const agent = pureDispatcherAgent(model);
    const parts: StreamPart[] = [];

    const { runState } = await setupDurableHarness('abort-propagates', 'abort-propagates');
    runState.messages = [{ role: 'user', content: 'anything' }];

    await expect(
      classifyHostTarget({
        agent,
        run: runState,
        model,
        allowKeep: false,
        emit: (part) => parts.push(part),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(classifierFallbackEvents(parts)).toHaveLength(0);
  });

  it('a classifier failure propagates for an answering agent (allowKeep: true)', async () => {
    const model = mockV3GenerateObjectModel(async () => {
      throw new Error('NoObjectGeneratedError');
    });
    const agent = defineAgent({
      id: 'host',
      instructions: 'Route internally',
      routes: [
        { agent: 'billing', when: 'billing' },
        { agent: 'support', when: 'support' },
      ],
      model: stubModel,
    });

    const { runState } = await setupDurableHarness('guard-throw', 'guard-throw');
    runState.messages = [{ role: 'user', content: 'hello' }];

    await expect(
      classifyHostTarget({ agent, run: runState, model, allowKeep: true }),
    ).rejects.toThrow('NoObjectGeneratedError');
  });
});
