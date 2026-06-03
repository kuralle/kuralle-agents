import { describe, expect, it, mock, afterEach } from 'bun:test';
import { z } from 'zod';
import { collect, decide, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { VoiceDriver } from '../../src/runtime/channels/VoiceDriver.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { setPendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { Flow } from '../../src/types/flow.js';
import { FakeRealtimeAudioClient, flushMicrotasks } from '../helpers/fakeRealtimeClient.js';

afterEach(() => {
  mock.restore();
});

const STRUCTURAL = new Set([
  'flow-enter',
  'node-enter',
  'flow-transition',
  'tool-call',
  'tool-result',
  'flow-end',
]);

function pickStructural(parts: HarnessStreamPart[]): HarnessStreamPart[] {
  return parts
    .filter((p) => STRUCTURAL.has(p.type))
    .map((p) => {
      if (p.type === 'tool-call' || p.type === 'tool-result') {
        const { toolCallId: _id, ...rest } = p as HarnessStreamPart & { toolCallId?: string };
        return rest as HarnessStreamPart;
      }
      return p;
    });
}

function buildCollectDecideReplyFlow(): Flow {
  const premiumReply = reply({
    id: 'premium',
    instructions: 'Confirm premium tier',
    next: () => ({ end: 'completed' }),
  });

  const decideNode = decide({
    id: 'route',
    instructions: 'Classify tier',
    schema: z.object({ tier: z.enum(['standard', 'premium']) }),
    decide: () => premiumReply,
  });

  const collectName = collect({
    id: 'name',
    schema: z.object({ name: z.string().min(1) }),
    onComplete: () => decideNode,
  });

  return defineFlow({
    name: 'parity-flow',
    description: 'collect decide reply',
    start: collectName,
    nodes: [collectName, decideNode, premiumReply],
  });
}

async function runTextParity(flow: Flow) {
  let textStreamCall = 0;

  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      streamText: () => {
        textStreamCall += 1;
        if (textStreamCall === 1) {
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta', text: 'What is your name?' };
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        }
        if (textStreamCall === 2) {
          return {
            fullStream: (async function* () {
              yield {
                type: 'tool-call',
                toolCallId: 'tc-1',
                toolName: 'submit_name_data',
                input: { name: 'Jordan' },
              };
            })(),
            finishReason: Promise.resolve('tool-calls'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([
              { toolCallId: 'tc-1', toolName: 'submit_name_data', input: { name: 'Jordan' } },
            ]),
          };
        }
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'Premium confirmed.' };
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        };
      },
      generateObject: () => Promise.resolve({ object: { tier: 'premium' } }),
    };
  });

  const textDriver = new TextDriver();
  const { session, runStore, runState } = await setupDurableHarness('text-p1', 'text-run-p1');
  const parts: HarnessStreamPart[] = [];
  const ctx = await createRunContext({
    session,
    runStore,
    runState,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (p) => parts.push(p),
  });

  const phase1 = await runFlow(flow, runState, textDriver, ctx);
  expect(phase1.kind).toBe('awaitingUser');

  setPendingUserInput(session, 'My name is Jordan');
  const parts2: HarnessStreamPart[] = [];
  const ctx2 = await createRunContext({
    session,
    runStore,
    runState,
    steps: await runStore.getSteps(runState.runId),
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (p) => parts2.push(p),
  });

  const phase2 = await runFlow(flow, runState, textDriver, ctx2);
  return {
    result: phase2,
    state: runState.state,
    events: pickStructural([...parts, ...parts2]),
  };
}

async function runVoiceParity(flow: Flow) {
  // Collect extraction is now a non-speaking text-model turn on BOTH drivers, so
  // the voice harness mocks streamText for the two extraction turns exactly like
  // the text harness; the realtime client only serves the (speaking) reply turn.
  let voiceStreamCall = 0;
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      streamText: () => {
        voiceStreamCall += 1;
        if (voiceStreamCall === 1) {
          return {
            fullStream: (async function* () {
              yield { type: 'text-delta', text: 'What is your name?' };
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        }
        return {
          fullStream: (async function* () {
            yield {
              type: 'tool-call',
              toolCallId: 'tc-1',
              toolName: 'submit_name_data',
              input: { name: 'Jordan' },
            };
          })(),
          finishReason: Promise.resolve('tool-calls'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([
            { toolCallId: 'tc-1', toolName: 'submit_name_data', input: { name: 'Jordan' } },
          ]),
        };
      },
      generateObject: () => Promise.resolve({ object: { tier: 'premium' } }),
    };
  });

  const fakeClient = new FakeRealtimeAudioClient({
    responses: {
      jordan: {
        toolCalls: [{ name: 'submit_name_data', args: { name: 'Jordan' } }],
        text: 'Thanks.',
      },
    },
    defaultResponse: { text: 'What is your name?' },
  });
  await fakeClient.connect({ systemInstruction: '', tools: [] });
  const voiceDriver = new VoiceDriver({ client: fakeClient });

  const { session, runStore, runState } = await setupDurableHarness('voice-p1', 'voice-run-p1');
  const parts: HarnessStreamPart[] = [];
  const ctx = await createRunContext({
    session,
    runStore,
    runState,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (p) => parts.push(p),
  });

  const phase1 = await runFlow(flow, runState, voiceDriver, ctx);
  expect(phase1.kind).toBe('awaitingUser');

  fakeClient.injectUserUtterance('My name is Jordan');
  await flushMicrotasks();

  runState.messages.push({ role: 'user', content: 'My name is Jordan' });
  fakeClient.lastUserText = 'My name is Jordan';

  const parts2: HarnessStreamPart[] = [];
  const ctx2 = await createRunContext({
    session,
    runStore,
    runState,
    steps: await runStore.getSteps(runState.runId),
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (p) => parts2.push(p),
  });

  const phase2 = await runFlow(flow, runState, voiceDriver, ctx2);
  return {
    result: phase2,
    state: runState.state,
    events: pickStructural([...parts, ...parts2]),
  };
}

describe('voice-text parity (INV-3)', () => {
  it('collect→decide→reply yields identical structural events on text and voice', async () => {
    const flow = buildCollectDecideReplyFlow();
    const text = await runTextParity(flow);
    const voice = await runVoiceParity(flow);

    expect(text.result).toEqual({ kind: 'ended', reason: 'completed' });
    expect(voice.result).toEqual({ kind: 'ended', reason: 'completed' });
    expect(text.state.__collect_name).toEqual({ name: 'Jordan' });
    expect(voice.state.__collect_name).toEqual({ name: 'Jordan' });
    expect(voice.events.map((e) => e.type)).toEqual(text.events.map((e) => e.type));
  });
});
