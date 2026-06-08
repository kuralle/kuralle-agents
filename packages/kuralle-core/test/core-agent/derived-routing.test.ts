import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../src/types/flow.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostGuardVerdict } from '../../src/runtime/select.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { buildAgentReplyNode } from '../../src/runtime/agentReply.js';
import { resolveHostControl } from '../../src/runtime/hostControlGuard.js';
import { FakeRealtimeAudioClient } from '../helpers/fakeRealtimeClient.js';

describe('derived host routing', () => {
  it('answering keep turn does not call classifier when no host targets need guard-only path', async () => {
    const agent = defineAgent({
      id: 'solo',
      instructions: 'Answer briefly',
      model: stubModel,
    });

    let classifyCalls = 0;
    const classify = async (): Promise<HostGuardVerdict> => {
      classifyCalls += 1;
      return { action: 'keep' };
    };

    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        return { text: 'answer', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('keep', 'keep');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    await hostLoop({ agent, run: runState, driver, ctx, classify });
    expect(classifyCalls).toBe(0);
  });

  it('transfer control produces no persisted assistant message', async () => {
    const agent = defineAgent({
      id: 'host',
      instructions: 'Route internally',
      routes: [{ agent: 'billing', when: 'billing' }],
      model: stubModel,
    });

    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        return {
          text: 'dispatch prose',
          toolResults: [],
          control: { type: 'handoff' as const, target: 'billing', reason: 'billing' },
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'bill me' };
      },
    };

    const classify = async (): Promise<HostGuardVerdict> => ({ action: 'keep' });

    const { session, runStore, runState } = await setupDurableHarness('xfer', 'xfer');
    runState.messages = [{ role: 'user', content: 'bill me' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    await hostLoop({ agent, run: runState, driver, ctx, classify });
    const assistant = runState.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(0);
  });

  it('main model control wins over guard when both fire', async () => {
    const end = reply({ id: 'e', instructions: 'x', next: () => ({ end: 'ok' }) });
    const flowA = defineFlow({ name: 'a', description: 'A', start: end, nodes: [end] });
    const flowB = defineFlow({ name: 'b', description: 'B', start: end, nodes: [end] });
    const agent = defineAgent({
      id: 'multi',
      instructions: 'help',
      flows: [flowA, flowB],
      model: stubModel,
    });
    const { runState } = await setupDurableHarness('resolve', 'resolve');

    const main = { type: 'enterFlow' as const, flowName: 'a' };
    const guard = { action: 'enterFlow' as const, flowName: 'b' };
    // Valid main control wins regardless of mainAnswered.
    expect(resolveHostControl(main, guard, agent, runState, false)).toEqual(main);
    expect(resolveHostControl(main, guard, agent, runState, true)).toEqual(main);
    // No main control: guard applies only when the model did NOT answer.
    expect(resolveHostControl(undefined, guard, agent, runState, false)).toEqual({
      type: 'enterFlow',
      flowName: 'b',
    });
    expect(resolveHostControl(undefined, guard, agent, runState, true)).toBeUndefined();
    // Guard 'keep' never produces control.
    expect(
      resolveHostControl(undefined, { action: 'keep' }, agent, runState, false),
    ).toBeUndefined();
  });

  it('buildAgentReplyNode exposes enter_flow and transfer_to_agent for answering agents', async () => {
    const end = reply({ id: 'e', instructions: 'x', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({ name: 'book', description: 'Book', start: end, nodes: [end] });
    const child = defineAgent({ id: 'billing', description: 'Billing help', model: stubModel });
    const agent = defineAgent({
      id: 'host',
      instructions: 'help',
      flows: [flow],
      routes: [{ agent: 'billing', when: 'billing questions' }],
      agents: [child],
      model: stubModel,
    });
    const { runState } = await setupDurableHarness('tools', 'tools');
    const node = buildAgentReplyNode(agent, runState);
    expect(node.tools && 'enter_flow' in node.tools).toBe(true);
    expect(node.tools && 'transfer_to_agent' in node.tools).toBe(true);
  });
});

// The guard is a forgot-to-route net, NOT a second-guesser. It must override
// ONLY when the model produced no substantive answer. A model that answers has
// chosen `keep`; a disagreeing guard must not hijack that answer (doing so
// mis-routed Q&A turns into flows — observed in the live smoke).
describe('guard does not override a substantive answer', () => {
  function mockStreamText(text: string) {
    return async () => {
      const { mock } = await import('bun:test');
      mock.module('ai', () => {
        const actual = require('ai');
        return {
          ...actual,
          streamText: () => ({
            fullStream: (async function* () {
              if (text) yield Object.assign({ type: 'text-delta' }, { text });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          }),
        };
      });
    };
  }

  async function runWithGuard(answerText: string) {
    const parts: HarnessStreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (p) => parts.push(p),
    });
    const node = reply({ id: 'greet', instructions: 'Say hello' });
    const resolved = resolveReplyNode(node, {}, { freeConversation: true });
    resolved.hostControl = {
      dispatchMode: 'relaxed',
      advisoryDispatch: false,
      guard: Promise.resolve({ action: 'enterFlow', flowName: 'book' }),
    };
    const result = await new TextDriver().runAgentTurn(resolved, ctx);
    return { result, parts };
  }

  it('keeps the answer and does not route or cancel when the model answered', async () => {
    const { mock, afterEach } = await import('bun:test');
    afterEach(() => mock.restore());
    await mockStreamText('Hello, the deadline is March 31.')();

    const { result, parts } = await runWithGuard('Hello, the deadline is March 31.');
    expect(result.control).toBeUndefined();
    expect(result.text).toContain('March 31');
    expect(parts.some((p) => p.type === 'text-cancel')).toBe(false);
  });

  it('applies the guard route when the model produced no answer', async () => {
    const { mock, afterEach } = await import('bun:test');
    afterEach(() => mock.restore());
    await mockStreamText('')();

    const { result } = await runWithGuard('');
    expect(result.control?.type).toBe('enterFlow');
    expect(result.text).toBe('');
  });
});

// RR-03: strict dispatch must flush once the guard returns keep, then stream the
// remainder live — TTFT ≈ guard latency, NOT full-source completion.
describe('strict dispatch flush-on-keep', () => {
  it('emits the first token at guard latency, not after the slow tail of the source', async () => {
    const { mock, afterEach } = await import('bun:test');
    afterEach(() => mock.restore());
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'One' });
            await new Promise((r) => setTimeout(r, 400)); // slow tail
            yield Object.assign({ type: 'text-delta' }, { text: ' two' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const events: { type: string; at: number }[] = [];
    const start = Date.now();
    const { session, runStore, runState } = await setupDurableHarness('strict-flush', 'strict-flush');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (p) => events.push({ type: p.type, at: Date.now() - start }),
    });
    const node = reply({ id: 'g', instructions: 'hi' });
    const resolved = resolveReplyNode(node, {}, { freeConversation: true });
    resolved.hostControl = {
      dispatchMode: 'strict',
      advisoryDispatch: false,
      guard: new Promise((r) => setTimeout(() => r({ action: 'keep' }), 20)),
    };

    const result = await new TextDriver().runAgentTurn(resolved, ctx);
    const firstDelta = events.find((e) => e.type === 'text-delta');
    expect(result.text).toBe('One two');
    expect(firstDelta).toBeDefined();
    // Flushed at guard (~20ms); the old full-buffer path emitted only after ~400ms.
    expect(firstDelta!.at).toBeLessThan(250);
  });

  it('emits no text and routes when the guard routes on an empty answer (no leak)', async () => {
    const { mock, afterEach } = await import('bun:test');
    afterEach(() => mock.restore());
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {})(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });
    const events: HarnessStreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('strict-route', 'strict-route');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (p) => events.push(p),
    });
    const node = reply({ id: 'g', instructions: 'hi' });
    const resolved = resolveReplyNode(node, {}, { freeConversation: true });
    resolved.hostControl = {
      dispatchMode: 'strict',
      advisoryDispatch: false,
      guard: Promise.resolve({ action: 'enterFlow', flowName: 'book' }),
    };

    const result = await new TextDriver().runAgentTurn(resolved, ctx);
    expect(result.control?.type).toBe('enterFlow');
    expect(result.text).toBe('');
    expect(events.some((e) => e.type === 'text-delta')).toBe(false);
  });
});

// RR-01: native realtime must not drop a host-control tool result. The post-hoc
// gate previously clobbered out.control, silently dropping enter_flow/transfer.
describe('native realtime host control', () => {
  it('preserves an enter_flow tool control through the post-hoc gate', async () => {
    const flowNode = reply({ id: 'e', instructions: 'x', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({ name: 'book', description: 'Book an advisor appointment', start: flowNode, nodes: [flowNode] });
    const agent = defineAgent({ id: 'host', instructions: 'help', flows: [flow], model: stubModel });

    const { session, runStore, runState } = await setupDurableHarness('nrt-ctrl', 'nrt-ctrl');
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true; // emit the tool call manually below
    await fakeClient.connect({ systemInstruction: '', tools: [] });
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const resolved = resolveReplyNode(buildAgentReplyNode(agent, runState), {}, { freeConversation: true });
    const driver = new VoiceDriver({ client: fakeClient });
    const turnPromise = driver.runAgentTurn(resolved, ctx);
    await new Promise((r) => setTimeout(r, 5));
    fakeClient.emitToolCallTurn('enter_flow', { flowName: 'book', reason: 'user asked to book' });
    const turn = await turnPromise;

    expect(turn.control?.type).toBe('enterFlow');
    expect((turn.control as { flowName?: string }).flowName).toBe('book');
  });
});
