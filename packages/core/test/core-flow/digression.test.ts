import { describe, expect, it, mock, afterEach } from 'bun:test';

afterEach(() => mock.restore());
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { getCollectData, schemaSatisfied } from '../../src/flow/extraction.js';
import { getFlowPark, looksLikeOffScriptQuestion } from '../../src/flow/collectDigression.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { setPendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

function makeCollectFlow(id = 'name') {
  const done = reply({ id: 'done', instructions: 'Thanks.', next: () => ({ end: 'done' }) });
  const ask = collect({
    id,
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    onComplete: () => done,
  });
  const flow = defineFlow({
    name: 'intake',
    description: 'Collect a name',
    start: ask,
    nodes: [ask, done],
  });
  return { ask, done, flow };
}

function noAdvanceDriver() {
  return {
    async runExtraction() {
      return { text: 'ignored prose', toolResults: [] };
    },
    async runAgentTurn() {
      return { text: '', toolResults: [] };
    },
    async awaitUser(ctx: import('../../src/types/run-context.js').RunContext) {
      const { consumePendingUserInput } = await import('../../src/runtime/channels/inputBuffer.js');
      return { type: 'message' as const, input: consumePendingUserInput(ctx.session) };
    },
  };
}

function emitAnswerLifecycle(
  ctx: import('../../src/types/run-context.js').RunContext,
  text: string,
): void {
  const id = crypto.randomUUID();
  ctx.emit({ type: 'text-start', id });
  ctx.emit({ type: 'text-delta', id, delta: text });
  ctx.emit({ type: 'text-end', id });
  ctx.emit({ type: 'turn-end' });
}

describe('H5 in-flow digression (outOfBandControl)', () => {
  it('flag-OFF: off-script at collect re-asks without answer turn or route', async () => {
    const { ask, flow } = makeCollectFlow();
    const parts: HarnessStreamPart[] = [];
    let answerTurns = 0;

    const driver = {
      ...noAdvanceDriver(),
      async runAgentTurn() {
        answerTurns += 1;
        return { text: 'We are open 9-5.', toolResults: [] };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('h5-off', 'h5-off-run');
    runState.messages = [{ role: 'user', content: 'What are your hours?' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'What are your hours?');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: (p) => parts.push(p),
      outOfBandControl: false,
    });

    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(answerTurns).toBe(0);
    expect(parts.some((p) => p.type === 'text-delta' && /hours|open 9-5/i.test(String((p as { delta?: string }).delta)))).toBe(
      false,
    );
    expect(parts.some((p) => p.type === 'text-delta' && /name/i.test(String((p as { delta?: string }).delta)))).toBe(true);
    expect(runState.activeNode).toBe(ask.id);
  });

  it('flag-ON route: intent switch handoffs with collect node parked', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            action: 'transfer',
            flowName: null,
            agentId: 'billing-agent',
            reason: 'billing',
            confidence: 0.95,
          },
        }),
      };
    });

    const { ask, flow } = makeCollectFlow();
    const billingDone = reply({ id: 'bill-end', instructions: 'billing', next: () => ({ end: 'ok' }) });
    const billing = defineFlow({
      name: 'billing',
      description: 'Billing questions',
      start: billingDone,
      nodes: [billingDone],
    });

    const agent = defineAgent({
      id: 'router',
      model: {} as import('ai').LanguageModel,
      flows: [flow, billing],
      routes: [{ agent: 'billing-agent', when: 'billing invoice payment' }],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-route', 'h5-route-run');
    runState.messages = [{ role: 'user', content: 'I have a billing question about my invoice' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'I have a billing question about my invoice');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, noAdvanceDriver(), ctx, agent);

    expect(result).toEqual({ kind: 'handoff', to: 'billing-agent', reason: 'billing' });
    expect(runState.activeNode).toBe(ask.id);
    expect(getCollectData(runState.state, ask.id).name).toBeUndefined();
  });

  it('flag-ON enterFlow: switches flow and parks collect position', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            action: 'enterFlow',
            flowName: 'billing',
            agentId: null,
            reason: 'billing',
            confidence: 0.95,
          },
        }),
      };
    });

    const { ask, flow } = makeCollectFlow();
    const billingHold = reply({ id: 'bill-reply', instructions: 'How can I help with billing?' });
    const billing = defineFlow({
      name: 'billing',
      description: 'Billing questions',
      start: billingHold,
      nodes: [billingHold],
    });

    const agent = defineAgent({
      id: 'router',
      model: {} as import('ai').LanguageModel,
      flows: [flow, billing],
      routes: [{ flow: 'billing', when: 'billing invoice payment' }],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-switch', 'h5-switch-run');
    runState.messages = [{ role: 'user', content: 'billing invoice help' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'billing invoice help');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, noAdvanceDriver(), ctx, agent);

    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(getFlowPark(runState.state)).toEqual({ flow: 'intake', node: ask.id });
    expect(runState.activeFlow).toBe('billing');
    expect(runState.activeNode).toBe('bill-reply');
  });

  it('flag-ON answer-then-resume: answers off-script question then re-asks collect', async () => {
    const { ask, flow } = makeCollectFlow();
    const parts: HarnessStreamPart[] = [];
    let answerTurns = 0;

    const driver = {
      ...noAdvanceDriver(),
      async runAgentTurn(
        resolved: { freeConversation?: boolean },
        ctx: import('../../src/types/run-context.js').RunContext,
      ) {
        if (resolved.freeConversation) {
          answerTurns += 1;
          const text = 'We are open 9am to 5pm weekdays.';
          emitAnswerLifecycle(ctx, text);
          return { text, toolResults: [] };
        }
        return { text: '', toolResults: [] };
      },
    };

    const agent = defineAgent({
      id: 'support',
      model: {} as import('ai').LanguageModel,
      flows: [flow],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-answer', 'h5-answer-run');
    runState.messages = [{ role: 'user', content: 'What are your hours?' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'What are your hours?');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: (p) => parts.push(p),
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, driver, ctx, agent);

    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(answerTurns).toBe(1);
    expect(parts.some((p) => p.type === 'text-delta' && /9am|5pm/i.test(String((p as { delta?: string }).delta)))).toBe(
      true,
    );
    expect(parts.some((p) => p.type === 'text-delta' && /name/i.test(String((p as { delta?: string }).delta)))).toBe(true);
    expect(runState.activeNode).toBe(ask.id);

    setPendingUserInput(session, 'My name is Riley');
    runState.messages = [
      ...runState.messages,
      { role: 'user', content: 'My name is Riley' },
    ];
    ctx.turnInputConsumed = false;

    const resumeDriver = {
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Riley' },
              result: { name: 'Riley' },
            },
          ],
        };
      },
      async runAgentTurn() {
        return { text: 'Thanks Riley', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'My name is Riley' };
      },
    };

    const result2 = await runFlow(flow, runState, resumeDriver, ctx, agent);
    expect(result2.kind).toBe('ended');
    expect(schemaSatisfied(ask, runState.state)).toBe(true);
    expect(getCollectData(runState.state, ask.id).name).toBe('Riley');
  });

  it('flag-ON on-topic: valid field still advances collect without digression', async () => {
    const { ask, flow } = makeCollectFlow();
    let answerTurns = 0;

    const driver = {
      async runExtraction() {
        return {
          text: 'Thanks',
          toolResults: [
            { name: 'submit_name_data', args: { name: 'Riley' }, result: { name: 'Riley' } },
          ],
        };
      },
      async runAgentTurn(resolved: { freeConversation?: boolean }) {
        if (resolved.freeConversation) {
          answerTurns += 1;
        }
        return { text: 'done', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'My name is Riley' };
      },
    };

    const agent = defineAgent({
      id: 'support',
      model: {} as import('ai').LanguageModel,
      flows: [flow],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-collect', 'h5-collect-run');
    runState.messages = [{ role: 'user', content: 'My name is Riley' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'My name is Riley');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, driver, ctx, agent);
    expect(result.kind).toBe('ended');
    expect(answerTurns).toBe(0);
    expect(getCollectData(runState.state, ask.id).name).toBe('Riley');
  });

  it('flag-ON digression: runAgentTurn owns answer lifecycle — no double emit', async () => {
    const { ask, flow } = makeCollectFlow();
    const parts: HarnessStreamPart[] = [];
    let answerTurns = 0;

    const driver = {
      ...noAdvanceDriver(),
      async runAgentTurn(
        resolved: { freeConversation?: boolean },
        ctx: import('../../src/types/run-context.js').RunContext,
      ) {
        if (resolved.freeConversation) {
          answerTurns += 1;
          const text = 'We are open 9am to 5pm weekdays.';
          emitAnswerLifecycle(ctx, text);
          return { text, toolResults: [] };
        }
        return { text: '', toolResults: [] };
      },
    };

    const agent = defineAgent({
      id: 'support',
      model: {} as import('ai').LanguageModel,
      flows: [flow],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-single-emit', 'h5-single-emit-run');
    runState.messages = [{ role: 'user', content: 'What are your hours?' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'What are your hours?');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: (p) => parts.push(p),
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, driver, ctx, agent);

    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(answerTurns).toBe(1);

    const digressionDeltas = parts.filter(
      (p) => p.type === 'text-delta' && /9am|5pm/i.test(String((p as { delta?: string }).delta)),
    );
    const digressionStarts = parts.filter(
      (p) =>
        p.type === 'text-start' &&
        digressionDeltas.some((d) => (d as { id?: string }).id === (p as { id?: string }).id),
    );
    const digressionEnds = parts.filter(
      (p) =>
        p.type === 'text-end' &&
        digressionDeltas.some((d) => (d as { id?: string }).id === (p as { id?: string }).id),
    );

    expect(digressionDeltas).toHaveLength(1);
    expect(digressionStarts).toHaveLength(1);
    expect(digressionEnds).toHaveLength(1);

    const reAskDeltas = parts.filter(
      (p) => p.type === 'text-delta' && /name/i.test(String((p as { delta?: string }).delta)),
    );
    expect(reAskDeltas).toHaveLength(1);
    expect(runState.activeNode).toBe(ask.id);
  });

  it('flag-ON no loop: at most one free-conversation answer per digression turn', async () => {
    const { ask, flow } = makeCollectFlow();
    let answerTurns = 0;

    const driver = {
      ...noAdvanceDriver(),
      async runAgentTurn(resolved: { freeConversation?: boolean }) {
        if (resolved.freeConversation) {
          answerTurns += 1;
        }
        return { text: 'Answer once.', toolResults: [] };
      },
    };

    const agent = defineAgent({
      id: 'support',
      model: {} as import('ai').LanguageModel,
      flows: [flow],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-loop', 'h5-loop-run');
    runState.messages = [{ role: 'user', content: 'Why is the sky blue?' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'Why is the sky blue?');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: () => {},
      outOfBandControl: true,
    });

    await runFlow(flow, runState, driver, ctx, agent);
    expect(answerTurns).toBe(1);
  });

  it('multi-intent deferred: single off-script question handled; field+digression not split in one turn', async () => {
    expect(looksLikeOffScriptQuestion('What are your hours?')).toBe(true);
    expect(looksLikeOffScriptQuestion('Riley')).toBe(false);

    const { ask, flow } = makeCollectFlow();
    const driver = {
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            { name: 'submit_name_data', args: { name: 'Riley' }, result: { name: 'Riley' } },
          ],
        };
      },
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return {
          type: 'message' as const,
          input: 'My name is Riley — also what are your hours?',
        };
      },
    };

    const agent = defineAgent({
      id: 'support',
      model: {} as import('ai').LanguageModel,
      flows: [flow],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness('h5-multi', 'h5-multi-run');
    runState.messages = [{ role: 'user', content: 'My name is Riley — also what are your hours?' }];
    runState.activeFlow = flow.name;
    runState.activeNode = ask.id;
    setPendingUserInput(session, 'My name is Riley — also what are your hours?');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: {} as import('ai').LanguageModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, driver, ctx, agent);
    expect(result.kind).toBe('ended');
    expect(getCollectData(runState.state, ask.id).name).toBe('Riley');
  });
});
