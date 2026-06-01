import { describe, expect, it, mock, afterEach } from 'bun:test';
import { z } from 'zod';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { buildToolSet, defineTool, CoreToolExecutor, ToolValidationError } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { resolveVoiceGeminiTools } from '../../src/runtime/channels/voiceTools.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import {
  FakeRealtimeAudioClient,
  flushMicrotasks,
} from '../helpers/fakeRealtimeClient.js';

async function waitForDriverReady(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
  mock.restore();
});

describe('LLM-brain conformance gates G1–G6', () => {
  it('G1: flow transition reconfigures session without new inference', async () => {
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    await fakeClient.connect({ systemInstruction: '', tools: [] });
    const driver = new VoiceDriver({ client: fakeClient });

    const beforeInference = fakeClient.inferenceCallCount;
    await driver.reconfigure({ systemInstruction: 'Node B prompt', tools: [] });

    expect(fakeClient.configHistory.length).toBe(1);
    expect(fakeClient.configHistory[0]?.systemInstruction).toBe('Node B prompt');
    expect(fakeClient.inferenceCallCount).toBe(beforeInference);
  });

  it('G2: function-call request/response pairing holds incl. CANCELLED on barge-in', async () => {
    const slow = defineTool({
      name: 'slow_tool',
      description: 'Slow tool',
      interruptible: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      },
    });

    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const executor = new CoreToolExecutor({ tools: { slow_tool: slow } });
    const driver = new VoiceDriver({ client: fakeClient, toolDefs: { slow_tool: slow } });
    const { session, runStore, runState } = await setupDurableHarness('g2-sess', 'g2-run');

    const bargeController = new AbortController();
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      bargeIn: bargeController.signal,
      emit: () => {},
    });

    const node = reply({ id: 'r', instructions: 'Run slow tool' });
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);

    await waitForDriverReady();
    fakeClient.emitToolCallTurn('slow_tool');
    await new Promise((r) => setTimeout(r, 10));
    bargeController.abort();
    await flushMicrotasks();

    await turnPromise;

    const pairs = executor.getPairs();
    expect(pairs.length).toBe(1);
    expect(pairs[0]?.response.status).toBe('cancelled');
    expect(pairs[0]?.response.result).toMatchObject({ __tool_status: 'CANCELLED' });
  });

  it('G3: persisted transcript equals heard prefix after barge-in', async () => {
    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });
    const driver = new VoiceDriver({ client: fakeClient });
    const { session, runStore, runState } = await setupDurableHarness('g3-sess', 'g3-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const node = reply({ id: 'r', instructions: 'Long reply' });
    const heard = 'Partial output here';
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);
    await waitForDriverReady();
    fakeClient.injectBargeIn('user interrupt', heard);
    await flushMicrotasks();

    const turn = await turnPromise;
    expect(turn.text).toBe(heard);
    expect(turn.truncateAt).toBe(heard.length);
  });

  it('G4: each node exposes only its minimal tool set to the provider', async () => {
    const alpha = defineTool({
      name: 'alpha_tool',
      description: 'Alpha only',
      execute: async () => ({ a: 1 }),
    });

    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    await fakeClient.connect({ systemInstruction: '', tools: [] });
    const driver = new VoiceDriver({ client: fakeClient, toolDefs: { alpha_tool: alpha } });

    const nodeA = reply({
      id: 'a',
      instructions: 'A',
      tools: buildToolSet({ alpha_tool: alpha }),
    });

    await driver.reconfigure({
      systemInstruction: 'A',
      tools: resolveVoiceGeminiTools(resolveReplyNode(nodeA, {}), { alpha_tool: alpha }),
    });

    const toolNames = fakeClient.receivedConfig?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toEqual(['alpha_tool']);
  });

  it('G5: slow tool emits interim message', async () => {
    const interimMessages: string[] = [];
    const slow = defineTool({
      name: 'slow',
      description: 'Slow',
      interim: 'One moment…',
      interimAfterMs: 5,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { done: true };
      },
    });

    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const executor = new CoreToolExecutor({
      tools: { slow },
      onInterim: (msg) => interimMessages.push(msg),
    });
    const driver = new VoiceDriver({ client: fakeClient, toolDefs: { slow } });
    const { session, runStore, runState } = await setupDurableHarness('g5-sess', 'g5-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({ id: 'r', instructions: 'Go', tools: buildToolSet({ slow }) });
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);
    await waitForDriverReady();
    fakeClient.emitToolCallTurn('slow');
    await turnPromise;

    expect(interimMessages).toContain('One moment…');
  });

  it('G6: LLM-generated args sanitized before backend', async () => {
    let backendHit = false;
    const ticket = defineTool({
      name: 'create_ticket',
      description: 'Create ticket',
      input: z.object({ title: z.string().min(1), priority: z.enum(['low', 'high']) }),
      execute: async () => {
        backendHit = true;
        return { id: '1' };
      },
    });

    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const executor = new CoreToolExecutor({ tools: { create_ticket: ticket } });
    const driver = new VoiceDriver({ client: fakeClient, toolDefs: { create_ticket: ticket } });
    const { session, runStore, runState } = await setupDurableHarness('g6-sess', 'g6-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({ id: 'r', instructions: 'Ticket', tools: buildToolSet({ create_ticket: ticket }) });
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);
    await waitForDriverReady();
    fakeClient.emitToolCallTurn('create_ticket', { title: '', priority: 'invalid' });

    await expect(turnPromise).rejects.toBeInstanceOf(ToolValidationError);
    expect(backendHit).toBe(false);
  });

  it('G7: flow-local tool wins over same-named registry tool (text)', async () => {
    let registryHits = 0;
    let localHits = 0;

    const registryTool = defineTool({
      name: 'pick_winner',
      description: 'Registry executor',
      execute: async () => {
        registryHits += 1;
        return { winner: 'registry' };
      },
    });

    const localTool = defineTool({
      name: 'pick_winner',
      description: 'Flow-local executor',
      input: z.object({ side: z.literal('local') }),
      execute: async () => {
        localHits += 1;
        return { winner: 'local' };
      },
    });

    let streamCall = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCall += 1;
          if (streamCall === 1) {
            return {
              fullStream: (async function* () {
                yield { type: 'text-delta', text: 'Picking' };
              })(),
              finishReason: Promise.resolve('tool-calls'),
              response: Promise.resolve({ messages: [] }),
              toolCalls: Promise.resolve([
                {
                  toolName: 'pick_winner',
                  toolCallId: 'call-local',
                  input: { side: 'local' },
                },
              ]),
            };
          }
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta', text: ' Done' };
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const executor = new CoreToolExecutor({ tools: { pick_winner: registryTool } });
    const { session, runStore, runState } = await setupDurableHarness('g7-text-sess', 'g7-text-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({
      id: 'r',
      instructions: 'Pick winner',
      tools: buildToolSet({ pick_winner: localTool }),
    });
    const driver = new TextDriver();
    const turn = await driver.runAgentTurn(resolveReplyNode(node, {}), ctx);

    expect(turn.toolResults[0]?.result).toEqual({ winner: 'local' });
    expect(localHits).toBe(1);
    expect(registryHits).toBe(0);
  });

  it('G7: flow-local tool wins over same-named registry tool (voice)', async () => {
    let registryHits = 0;
    let localHits = 0;

    const registryTool = defineTool({
      name: 'pick_winner',
      description: 'Registry executor',
      execute: async () => {
        registryHits += 1;
        return { winner: 'registry' };
      },
    });

    const localTool = defineTool({
      name: 'pick_winner',
      description: 'Flow-local executor',
      input: z.object({ side: z.literal('local') }),
      execute: async () => {
        localHits += 1;
        return { winner: 'local' };
      },
    });

    const fakeClient = new FakeRealtimeAudioClient({ responses: {} });
    fakeClient.stallResponse = true;
    await fakeClient.connect({ systemInstruction: '', tools: [] });

    const executor = new CoreToolExecutor({ tools: { pick_winner: registryTool } });
    const driver = new VoiceDriver({ client: fakeClient, toolDefs: { pick_winner: registryTool } });
    const { session, runStore, runState } = await setupDurableHarness('g7-voice-sess', 'g7-voice-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({
      id: 'r',
      instructions: 'Pick winner',
      tools: buildToolSet({ pick_winner: localTool }),
    });
    const turnPromise = driver.runAgentTurn(resolveReplyNode(node, {}), ctx);
    await waitForDriverReady();
    fakeClient.emitToolCallTurn('pick_winner', { side: 'local' });
    const turn = await turnPromise;

    expect(turn.toolResults[0]?.result).toEqual({ winner: 'local' });
    expect(localHits).toBe(1);
    expect(registryHits).toBe(0);
  });
});
