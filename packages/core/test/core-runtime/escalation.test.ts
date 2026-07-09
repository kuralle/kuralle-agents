import { describe, expect, it, mock, afterEach } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { EscalationRequest } from '../../src/escalation/types.js';
import type { HarnessStreamPart, TurnHandle } from '../../src/types/stream.js';

afterEach(() => {
  mock.restore();
});

function mockSummaryModel(summary = 'User Jane needs a refund for order #42.') {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      generateText: async () => ({ text: summary }),
    };
  });
}

async function collectParts(handle: TurnHandle) {
  const parts: HarnessStreamPart[] = [];
  for await (const part of handle.events) {
    parts.push(part);
  }
  await handle;
  return parts;
}

describe('escalation loop', () => {
  it('terminal handoff to human builds the request, calls the handler, records and emits', async () => {
    mockSummaryModel();
    const sessionStore = new MemoryStore();
    const requests: EscalationRequest[] = [];

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return {
          text: '',
          toolResults: [],
          control: { type: 'escalate', reason: 'user asked for a human', category: 'user-request' },
        };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      escalation: {
        handler: async (request) => {
          requests.push(request);
          return { status: 'queued', queueId: 'q-1', estimatedWaitSec: 60 };
        },
      },
    });

    const handle = runtime.run({
      sessionId: 'esc-sess',
      input: 'I want to talk to a person about order #42',
      userId: 'user-9',
      driver,
    });
    const parts = await collectParts(handle);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.sessionId).toBe('esc-sess');
    expect(request.userId).toBe('user-9');
    expect(request.reason).toBe('user asked for a human');
    expect(request.category).toBe('user-request');
    expect(request.summary).toBe('User Jane needs a refund for order #42.');
    expect(request.recentMessages.some((m) => m.content.includes('order #42'))).toBe(true);

    const escalationPart = parts.find((part) => part.type === 'escalation');
    expect(escalationPart).toBeDefined();
    if (escalationPart?.type === 'escalation') {
      expect(escalationPart.outcome).toBe('queued');
      expect(escalationPart.summary).toContain('refund');
    }

    const session = await sessionStore.get('esc-sess');
    expect(session?.metadata?.lastEscalation?.handlerOutcome).toBe('queued');
    expect(session?.metadata?.lastEscalation?.reason).toBe('user-request');

    const runStore = new SessionRunStore(sessionStore, 'esc-sess');
    const runState = await runStore.getRunState(sessionDerivedRunId('esc-sess'));
    expect(runState?.status).toBe('paused');
  });

  it('handler errors become a failed outcome without killing the turn', async () => {
    mockSummaryModel();
    const sessionStore = new MemoryStore();
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: '', toolResults: [], control: { type: 'escalate', reason: 'boom path' } };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      escalation: {
        handler: async () => {
          throw new Error('queue service down');
        },
      },
    });

    const handle = runtime.run({ sessionId: 'esc-fail', input: 'help', driver });
    const parts = await collectParts(handle);

    const escalationPart = parts.find((part) => part.type === 'escalation');
    expect(escalationPart).toBeDefined();
    if (escalationPart?.type === 'escalation') {
      expect(escalationPart.outcome).toBe('failed');
    }
    const session = await sessionStore.get('esc-fail');
    expect(session?.metadata?.lastEscalation?.handlerOutcome).toBe('failed');
  });

  it('no escalation config → terminal handoff behaves exactly as before', async () => {
    const sessionStore = new MemoryStore();
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: '', toolResults: [], control: { type: 'escalate', reason: 'r' } };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
    });

    const handle = runtime.run({ sessionId: 'no-esc', input: 'x', driver });
    const parts = await collectParts(handle);
    expect(parts.find((part) => part.type === 'escalation')).toBeUndefined();
    expect(parts.find((part) => part.type === 'handoff')).toBeDefined();
  });

  it('flow escalate() pause fires the handler once (latched against post-resume double-fire)', async () => {
    mockSummaryModel();
    const sessionStore = new MemoryStore();
    const handled: string[] = [];

    const node = reply({
      id: 'r',
      instructions: 'reply',
      next: () => ({ escalate: 'needs human approval' }),
    });
    const flow = defineFlow({ name: 'esc-flow', description: 'x', start: node, nodes: [node] });

    let turns = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        turns += 1;
        if (turns === 1) {
          return { text: '', toolResults: [], control: { type: 'enterFlow', flowName: 'esc-flow' } };
        }
        return { text: 'let me get a human', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', flows: [flow], model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      escalation: {
        handler: async (request) => {
          handled.push(request.reason);
          return { status: 'queued', queueId: 'q-2' };
        },
      },
    });

    const handle = runtime.run({ sessionId: 'flow-esc', input: 'start', driver });
    const parts = await collectParts(handle);

    expect(handled).toEqual(['needs human approval']);
    expect(parts.find((part) => part.type === 'escalation')).toBeDefined();

    const runStore = new SessionRunStore(sessionStore, 'flow-esc');
    const runState = await runStore.getRunState(sessionDerivedRunId('flow-esc'));
    expect(runState?.waitingFor?.signalName).toBe('__escalate');
    expect(runState?.state.__escalationNotified).toBe(true);
  });

  it('resumeFromEscalation appends the resolution note and clears parked state', async () => {
    mockSummaryModel();
    const sessionStore = new MemoryStore();
    const node = reply({
      id: 'r',
      instructions: 'reply',
      next: () => ({ escalate: 'needs human' }),
    });
    const flow = defineFlow({ name: 'esc-flow', description: 'x', start: node, nodes: [node] });
    let turns = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        turns += 1;
        if (turns === 1) {
          return { text: '', toolResults: [], control: { type: 'enterFlow', flowName: 'esc-flow' } };
        }
        return { text: 'escalating', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', flows: [flow], model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      escalation: { handler: async () => ({ status: 'queued', queueId: 'q' }) },
    });

    await runtime.run({ sessionId: 'resume-sess', input: 'start', driver });

    await runtime.resumeFromEscalation('resume-sess', {
      resolutionSummary: 'Refund of $20 issued for order #42.',
    });

    const runStore = new SessionRunStore(sessionStore, 'resume-sess');
    const runState = await runStore.getRunState(sessionDerivedRunId('resume-sess'));
    expect(runState?.status).toBe('running');
    expect(runState?.waitingFor).toBeUndefined();
    expect(runState?.activeFlow).toBeUndefined();
    expect(runState?.state.__escalationNotified).toBeUndefined();

    const lastMessage = runState?.messages[runState.messages.length - 1];
    expect(lastMessage?.role).toBe('system');
    expect(String(lastMessage?.content)).toContain('Refund of $20 issued for order #42.');

    const session = await sessionStore.get('resume-sess');
    expect(String(session?.messages[session.messages.length - 1]?.content)).toContain(
      'human agent handled',
    );
  });
});
