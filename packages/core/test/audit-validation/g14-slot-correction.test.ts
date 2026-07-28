import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, collect, confirmGate, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { collectUntilComplete } from '../../src/flow/collectUntilComplete.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import {
  clearCollectData,
  getCollectData,
  schemaSatisfied,
} from '../../src/flow/extraction.js';
import {
  consumeAllPendingUserInput,
  hasPendingUserInput,
  peekPendingUserInput,
  setPendingUserInput,
} from '../../src/runtime/channels/inputBuffer.js';
import { userInputToText } from '../../src/runtime/userInput.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { RunContext } from '../../src/types/run-context.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import type { HostSelection } from '../../src/runtime/select.js';

describe('G14: clearCollectData clears collected slot', () => {
  it('clears data so schemaSatisfied is false, preserving the turn counter', () => {
    const node = collect({
      id: 'date',
      schema: z.object({ date: z.string(), venue: z.string() }),
      required: ['date', 'venue'],
      onComplete: () => ({ end: 'done' }),
    });
    const state: Record<string, unknown> = {
      __collect_date: { date: 'Thursday', venue: 'Main Hall' },
      __collectTurns_date: 2,
    };

    clearCollectData(state, node.id);

    expect(getCollectData(state, node.id)).toEqual({});
    expect(state.__collectTurns_date).toBe(2);
    expect(schemaSatisfied(node, state)).toBe(false);
  });
});

describe('G14: confirm gate decline re-injects correction', () => {
  it('leaves input pending and turnInputConsumed false on decline', async () => {
    const declineSink = action({
      id: 'decline-sink',
      run: async () => ({ end: 'declined' }),
    });
    const affirmSink = action({
      id: 'affirm-sink',
      run: async () => ({ end: 'affirmed' }),
    });

    const gate = confirmGate({
      id: 'confirm',
      instructions: 'Confirm the date?',
      onConfirm: affirmSink,
      onDecline: declineSink,
    });

    const flow = defineFlow({
      name: 'date-confirm',
      description: 'confirm only',
      start: gate,
      nodes: [gate, declineSink, affirmSink],
    });

    const correction = 'No, it should be Tuesday';
    const { session, runStore, runState } = await setupDurableHarness('g14-decline', 'g14-decline-run');
    runState.activeFlow = flow.name;
    runState.activeNode = 'confirm';
    runState.messages = [{ role: 'user', content: correction }];

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser(ctx: RunContext) {
        return { type: 'message' as const, input: consumeAllPendingUserInput(ctx.session) ?? '' };
      },
      async runStructured() {
        throw new Error('runStructured must not be called for confirm gates');
      },
    };

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'ended', reason: 'declined' });
    expect(hasPendingUserInput(session)).toBe(true);
    expect(userInputToText(peekPendingUserInput(session)!)).toBe(correction);
    expect(ctx.turnInputConsumed).toBe(false);
  });
});

describe('G14: collect does not early-complete with pending correction', () => {
  it('schemaSatisfied with pending input falls through to extraction', async () => {
    const completed: Array<Record<string, unknown>> = [];
    const dateCollect = collect({
      id: 'date',
      schema: z.object({ date: z.string(), venue: z.string() }),
      required: ['date', 'venue'],
      onComplete: (data) => {
        completed.push(data as Record<string, unknown>);
        return { end: 'done' };
      },
    });

    const { session, runStore, runState } = await setupDurableHarness('g14-collect', 'g14-collect-run');
    runState.state['__collect_date'] = { date: 'Thursday', venue: 'Main Hall' };
    setPendingUserInput(session, 'No, it should be Tuesday');

    const driver: ChannelDriver = {
      async runAgentTurn() {
        throw new Error('runAgentTurn must not be called');
      },
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_date_data',
              args: { date: 'Tuesday' },
              result: { date: 'Tuesday' },
              toolCallId: 'tc-1',
            },
          ],
        };
      },
      async awaitUser(ctx: RunContext) {
        return { type: 'message' as const, input: consumeAllPendingUserInput(ctx.session) ?? '' };
      },
    };

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const transition = await collectUntilComplete(dateCollect, runState, driver, ctx);

    expect(transition).toEqual({ kind: 'end', reason: 'done' });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({ date: 'Tuesday', venue: 'Main Hall' });
    expect(getCollectData(runState.state, dateCollect.id).date).toBe('Tuesday');
  });
});

describe('G14: confirm-decline correction overwrites stale slot end-to-end', () => {
  it('extracts Tuesday after decline and completes with corrected date', async () => {
    const completed: Array<Record<string, unknown>> = [];

    let gate!: ReturnType<typeof confirmGate>;
    const bookAction = action({ id: 'book', run: async () => ({ end: 'booked' }) });

    const dateCollect = collect({
      id: 'date',
      schema: z.object({ date: z.string(), venue: z.string() }),
      required: ['date', 'venue'],
      onComplete: (data) => {
        completed.push(data as Record<string, unknown>);
        return gate;
      },
    });

    gate = confirmGate({
      id: 'confirm',
      instructions: 'Confirm your booking details?',
      onConfirm: bookAction,
      onDecline: dateCollect,
    });

    const fullFlow = defineFlow({
      name: 'booking-confirm',
      description: 'collect booking then confirm',
      start: dateCollect,
      nodes: [dateCollect, gate, bookAction],
    });

    const correction = 'No, it should be Tuesday';
    const { session, runStore, runState } = await setupDurableHarness('g14-e2e', 'g14-e2e-run');
    runState.activeFlow = fullFlow.name;
    runState.activeNode = 'confirm';
    runState.state['__collect_date'] = { date: 'Thursday', venue: 'Main Hall' };
    runState.messages = [{ role: 'user', content: correction }];

    let extractionCalls = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async runExtraction() {
        extractionCalls += 1;
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_date_data',
              args: { date: 'Tuesday' },
              result: { date: 'Tuesday' },
              toolCallId: 'tc-1',
            },
          ],
        };
      },
      async awaitUser(ctx: RunContext) {
        return { type: 'message' as const, input: consumeAllPendingUserInput(ctx.session) ?? '' };
      },
      async runStructured() {
        throw new Error('runStructured must not be called for confirm gates');
      },
    };

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const result = await runFlow(fullFlow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(runState.activeNode).toBe('confirm');
    expect(extractionCalls).toBe(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({ date: 'Tuesday', venue: 'Main Hall' });
    expect(getCollectData(runState.state, dateCollect.id).date).toBe('Tuesday');
    expect(getCollectData(runState.state, dateCollect.id).venue).toBe('Main Hall');
  });

  it('accepts affirmation on the turn after a correction readback', async () => {
    const done = reply({
      id: 'done',
      instructions: 'Confirm the corrected day.',
      next: () => ({ end: 'booked' }),
    });
    const review = confirmGate({
      id: 'review',
      instructions: 'Confirm the appointment day.',
      onConfirm: done,
      onDecline: () => dateCollect,
    });
    const readback = reply({
      id: 'readback',
      instructions: 'Read back the appointment day.',
      next: () => review,
    });
    const dateCollect = collect({
      id: 'date',
      schema: z.object({ day: z.string() }),
      required: ['day'],
      onComplete: () => readback,
    });
    const flow = defineFlow({
      name: 'book',
      description: 'Book and confirm an appointment',
      start: dateCollect,
      nodes: [dateCollect, readback, review, done],
    });
    const agent = defineAgent({
      id: 'clinic',
      model: {} as import('ai').LanguageModel,
      flows: [flow],
    });
    const store = new MemoryStore();
    const sessionId = 'g14-confirm-after-correction';
    let extraction = 0;
    const spokenNodes: string[] = [];
    const driver: ChannelDriver = {
      async runAgentTurn(node) {
        spokenNodes.push(node.node.id);
        if (node.freeConversation) {
          return { text: '', toolResults: [] };
        }
        return {
          text: node.node.id === 'done' ? 'Confirmed for Tuesday.' : 'Is Tuesday correct?',
          toolResults: [],
        };
      },
      async runExtraction() {
        extraction += 1;
        const day = extraction === 1 ? 'Thursday' : 'Tuesday';
        return {
          text: '',
          toolResults: [{ name: 'submit_date_data', args: { day }, result: { day } }],
        };
      },
      async awaitUser(ctx) {
        return { type: 'message', input: consumeAllPendingUserInput(ctx.session) ?? '' };
      },
    };
    const hostSelect = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore: store,
      hostSelect,
    });

    await runtime.run({ sessionId, input: 'Book Thursday', driver });
    const beforeCorrection = await new SessionRunStore(store, sessionId).getRunState(
      sessionDerivedRunId(sessionId),
    );
    expect(beforeCorrection?.activeNode).toBe('review');
    await runtime.run({ sessionId, input: 'No, make it Tuesday instead', driver });
    const beforeAffirm = await new SessionRunStore(store, sessionId).getRunState(
      sessionDerivedRunId(sessionId),
    );
    expect(beforeAffirm?.activeNode).toBe('review');
    spokenNodes.length = 0;
    const third = runtime.run({ sessionId, input: 'Yes, that is correct.', driver });
    const result = await third;

    const state = await new SessionRunStore(store, sessionId).getRunState(
      sessionDerivedRunId(sessionId),
    );
    expect(state?.activeFlow).toBeUndefined();
    expect(spokenNodes).toEqual(['done']);
    expect(result.text).toBe('Confirmed for Tuesday.');
    expect(state?.state.__collect_date).toEqual({ day: 'Tuesday' });
  });
});
