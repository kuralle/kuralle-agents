import { describe, expect, it, mock, afterEach } from 'bun:test';
import { z } from 'zod';
import { reply, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { evaluateReplyControl } from '../../src/flow/controlEvaluator.js';
import { FLOW_TRANSITION_CONTROL_TOOL_NAMES } from '../../src/flow/flowControlTools.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { resolveVoiceGeminiTools } from '../../src/runtime/channels/voiceTools.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { CoreToolExecutor, defineTool } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import { tool as aiTool } from 'ai';

afterEach(() => {
  mock.restore();
});

const handoffEffect = defineTool({
  name: 'handoff',
  description: 'Route to another agent',
  input: z.object({ targetAgentId: z.string(), reason: z.string() }),
  execute: async () => ({
    __handoff: true,
    targetAgentId: 'billing',
    reason: 'billing',
  }),
});

const dataTool = defineTool({
  name: 'lookup',
  description: 'Lookup data',
  input: z.object({ q: z.string() }),
  execute: async () => ({ ok: true }),
});

function captureStreamText(captured: Record<string, unknown>[]) {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      streamText: (args: Record<string, unknown>) => {
        captured.push(args);
        return {
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'reply' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        };
      },
    };
  });
}

describe('evaluateReplyControl unit', () => {
  const replyNode = reply({ id: 'r', instructions: 'x' });

  it('interrupted → redispatch', async () => {
    const decision = await evaluateReplyControl({
      node: replyNode,
      turn: { text: 'partial', toolResults: [] },
      state: {},
      interrupted: true,
    });
    expect(decision).toEqual({ kind: 'redispatch' });
  });

  it('turn.control handoff → transition', async () => {
    const decision = await evaluateReplyControl({
      node: replyNode,
      turn: {
        text: 'x',
        toolResults: [],
        control: { type: 'handoff', target: 'billing', reason: 'r' },
      },
      state: {},
      interrupted: false,
    });
    expect(decision).toEqual({
      kind: 'transition',
      transition: { kind: 'handoff', to: 'billing', reason: 'r' },
    });
  });

  it('turn.control escalate → transition', async () => {
    const decision = await evaluateReplyControl({
      node: replyNode,
      turn: {
        text: 'x',
        toolResults: [],
        control: { type: 'escalate', reason: 'human needed' },
      },
      state: {},
      interrupted: false,
    });
    expect(decision).toEqual({
      kind: 'transition',
      transition: { kind: 'escalate', reason: 'human needed' },
    });
  });

  it('node.next wins when no control', async () => {
    const node = reply({
      id: 'r',
      instructions: 'x',
      next: () => ({ end: 'done' }),
    });
    const decision = await evaluateReplyControl({
      node,
      turn: { text: 'x', toolResults: [] },
      state: {},
      interrupted: false,
    });
    expect(decision).toEqual({
      kind: 'transition',
      transition: { kind: 'end', reason: 'done' },
    });
  });
});

describe('H1 out-of-band control (flag-gated)', () => {
  it('flag-OFF: speaking tool set includes control tools and node.next transition unchanged', async () => {
    const captured: Record<string, unknown>[] = [];
    captureStreamText(captured);

    const nextNode = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const greet = reply({
      id: 'greet',
      instructions: 'hi',
      next: () => nextNode,
    });
    const flow = defineFlow({ name: 'parity', description: 'x', start: greet, nodes: [greet, nextNode] });

    const { session, runStore, runState } = await setupDurableHarness('h1-off', 'h1-off-run');
    const parts: HarnessStreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { handoff: handoffEffect } }),
      model: stubModel,
      emit: (p) => parts.push(p),
      outOfBandControl: false,
    });

    const driver = new TextDriver({ toolDefs: { handoff: handoffEffect, lookup: dataTool } });
    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'ended', reason: 'ok' });
    const toolNames = Object.keys((captured[0]?.tools as Record<string, unknown>) ?? {});
    for (const name of FLOW_TRANSITION_CONTROL_TOOL_NAMES) {
      if (name === 'handoff') {
        expect(toolNames).toContain('handoff');
      }
    }
    expect(toolNames).toContain('lookup');
    expect(parts.filter((p) => p.type === 'text-delta').length).toBeGreaterThan(0);
  });

  it('flag-ON: flow reply speaking dict excludes control tools; executor still registered', async () => {
    const captured: Record<string, unknown>[] = [];
    captureStreamText(captured);

    const greet = reply({ id: 'greet', instructions: 'hi', next: () => ({ end: 'done' }) });
    const flow = defineFlow({ name: 'silo', description: 'x', start: greet, nodes: [greet] });

    const { session, runStore, runState } = await setupDurableHarness('h1-on-silo', 'h1-on-silo-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { handoff: handoffEffect, lookup: dataTool } }),
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const driver = new TextDriver({ toolDefs: { handoff: handoffEffect, lookup: dataTool } });
    await runFlow(flow, runState, driver, ctx);

    const toolNames = Object.keys((captured[0]?.tools as Record<string, unknown>) ?? {});
    expect(toolNames).not.toContain('handoff');
    expect(toolNames).toContain('lookup');
    expect(ctx.toolExecutor.getTool?.('handoff')).toBeDefined();
  });

  it('flag-ON: node.next transition; siloed model cannot override via handoff tool', async () => {
    let turnCalls = 0;
    const target = reply({ id: 'target', instructions: 't', next: () => ({ end: 'from-next' }) });
    const greet = reply({
      id: 'greet',
      instructions: 'hi',
      next: () => target,
    });
    const flow = defineFlow({ name: 'det', description: 'x', start: greet, nodes: [greet, target] });

    const driver = {
      async runAgentTurn() {
        turnCalls += 1;
        return { text: 'hello', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('h1-det', 'h1-det-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const result = await runFlow(flow, runState, driver, ctx);
    expect(result).toEqual({ kind: 'ended', reason: 'from-next' });
    expect(turnCalls).toBe(2);
  });

  it('flag-ON: data-tool control shape (__escalate) honored by evaluator', async () => {
    const escalateNode = reply({ id: 'esc', instructions: 'escalate' });
    const decision = await evaluateReplyControl({
      node: escalateNode,
      turn: {
        text: 'escalating',
        toolResults: [{ name: 'w1', args: {}, result: { __escalate: true, reason: 'human needed' } }],
        control: { type: 'escalate', reason: 'human needed' },
      },
      state: {},
      interrupted: false,
    });
    expect(decision).toEqual({
      kind: 'transition',
      transition: { kind: 'escalate', reason: 'human needed' },
    });
  });

  it('flag-ON: interrupted turn redispatches without appending assistant message', async () => {
    let dispatchCount = 0;
    const greet = reply({ id: 'greet', instructions: 'hi', next: () => ({ end: 'done' }) });
    const flow = defineFlow({ name: 'intr', description: 'x', start: greet, nodes: [greet] });

    const driver = {
      async runAgentTurn() {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          return { text: 'partial', toolResults: [], interrupted: true };
        }
        return { text: 'full', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'continue' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('h1-intr', 'h1-intr-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });

    await runFlow(flow, runState, driver, ctx);
    expect(dispatchCount).toBe(2);
    const assistantMsgs = runState.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.map((m) => (m as { content: string }).content)).not.toContain('partial');
    expect(assistantMsgs.some((m) => (m as { content: string }).content === 'full')).toBe(true);
  });

  it('flag-ON: free conversation keeps control tools in speaking dict', async () => {
    const captured: Record<string, unknown>[] = [];
    captureStreamText(captured);

    const agent = defineAgent({
      id: 'free-agent',
      instructions: 'help',
      model: stubModel,
      experimental: { outOfBandControl: true },
      tools: {
        handoff: aiTool({
          description: 'handoff',
          inputSchema: z.object({ targetAgentId: z.string(), reason: z.string() }),
          execute: async () => ({
            __handoff: true,
            targetAgentId: 'billing',
            reason: 'billing',
          }),
        }),
      },
    });

    const driver = new TextDriver({ toolDefs: { handoff: handoffEffect } });
    const { session, runStore, runState } = await setupDurableHarness('h1-free', 'h1-free-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { handoff: handoffEffect } }),
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });

    await hostLoop({ agent, run: runState, driver, ctx });

    const resolved = resolveReplyNode(
      { kind: 'reply', id: 'free-agent__host', instructions: 'help', tools: agent.tools },
      runState.state,
      { freeConversation: true },
    );
    const oobSilo = (free: boolean) => ({ siloFlowControl: !free });
    const freeTools = resolveVoiceGeminiTools(
      resolved,
      { handoff: handoffEffect },
      oobSilo(!!resolved.freeConversation),
    );
    const flowResolved = resolveReplyNode(reply({ id: 'n', instructions: 'x' }), {});
    const flowTools = resolveVoiceGeminiTools(
      flowResolved,
      { handoff: handoffEffect },
      oobSilo(!!flowResolved.freeConversation),
    );
    expect(freeTools.map((t) => t.name)).toContain('handoff');
    expect(flowTools.map((t) => t.name)).not.toContain('handoff');

    if (captured.length > 0) {
      const toolNames = Object.keys((captured[0]?.tools as Record<string, unknown>) ?? {});
      expect(toolNames).toContain('handoff');
    }
  });
});

describe('resolveReplyNode freeConversation marker', () => {
  it('sets freeConversation only when requested', () => {
    const node = reply({ id: 'n', instructions: 'x' });
    expect(resolveReplyNode(node, {}).freeConversation).toBeUndefined();
    expect(resolveReplyNode(node, {}, { freeConversation: true }).freeConversation).toBe(true);
  });
});
