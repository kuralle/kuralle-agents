import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  collect,
  createRuntime,
  defineAgent,
  defineFlow,
  reply,
} from '@kuralle-agents/core';
import type { ChannelDriver, StreamPart } from '@kuralle-agents/core';
import { MemoryStore } from '@kuralle-agents/core';

const stubModel = {} as import('ai').LanguageModel;

async function collectEvents(
  run: ReturnType<ReturnType<typeof createRuntime>['run']>,
): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of run.events) {
    parts.push(part);
  }
  await run;
  return parts;
}

describe('v2 offline flow + triage (text Runtime)', () => {
  const billing = defineAgent({
    id: 'billing',
    instructions: 'You are the billing specialist. Mention billing in your reply.',
    model: stubModel,
  });

  const confirm = reply({
    id: 'confirm',
    instructions: 'Confirm the collected name briefly.',
    next: () => ({ end: 'name-complete' }),
  });

  const nameCollect = collect({
    id: 'name',
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    maxTurns: 5,
    instructions: () => 'Ask for the user name in one short question.',
    onComplete: () => confirm,
  });

  const nameFlow = defineFlow({
    name: 'name-intake',
    description: 'Collect a name then confirm',
    start: nameCollect,
    nodes: [nameCollect, confirm],
  });

  const booking = defineAgent({
    id: 'booking',
    instructions: 'You help users update their profile name.',
    model: stubModel,
    flows: [nameFlow],
  });

  const support = defineAgent({
    id: 'support',
    instructions: 'General support. Route billing questions to billing.',
    model: stubModel,
    routes: [{ agent: 'billing', when: 'billing or payment questions' }],
    agents: [billing],
    routing: { model: stubModel },
  });

  it('progresses a flow across two nodes over multiple turns', async () => {
    let agentTurn = 0;
    let extractionTurn = 0;
    let userTurn = 0;
    const hostSelect = async () => ({ kind: 'enterFlow' as const, flow: nameFlow });

    const driver: ChannelDriver = {
      async runAgentTurn() {
        agentTurn += 1;
        if (agentTurn === 1) {
          return { text: '', toolResults: [] };
        }
        return { text: 'Thanks, Jordan.', toolResults: [] };
      },
      async runExtraction() {
        extractionTurn += 1;
        if (extractionTurn === 1) {
          return { text: '', toolResults: [] };
        }
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Jordan' },
              result: { name: 'Jordan' },
            },
          ],
        };
      },
      async awaitUser() {
        userTurn += 1;
        return {
          type: 'message',
          input: userTurn === 1 ? 'I want to update my name' : 'Jordan',
        };
      },
    };

    const runtime = createRuntime({
      agents: [booking],
      defaultAgentId: 'booking',
      sessionStore: new MemoryStore(),
      defaultModel: stubModel,
      hostSelect,
    });

    const turn1Parts = await collectEvents(
      runtime.run({
        sessionId: 'flow-session',
        input: 'I want to update my name',
        driver,
      }),
    );

    expect(
      turn1Parts.some(
        (p) => p.type === 'flow-enter' && p.payload.flow === 'name-intake',
      ),
    ).toBe(true);
    expect(turn1Parts.some((p) => p.type === 'node-enter' && p.payload.nodeName === 'name')).toBe(true);
    expect(turn1Parts.some((p) => p.type === 'flow-transition')).toBe(false);

    const turn2Parts = await collectEvents(
      runtime.run({
        sessionId: 'flow-session',
        input: 'Jordan',
        driver,
      }),
    );

    const transitions = turn2Parts.filter(
      (p): p is Extract<StreamPart, { type: 'flow-transition' }> => p.type === 'flow-transition',
    );
    expect(transitions.some((p) => p.payload.from === 'name' && p.payload.to === 'confirm')).toBe(true);
    expect(turn2Parts.some((p) => p.type === 'node-enter' && p.payload.nodeName === 'confirm')).toBe(true);
  });

  it('routes to a billing specialist via handoff', async () => {
    let calls = 0;
    let agentTurns = 0;
    const hostSelect = async () => {
      calls += 1;
      return { kind: 'route' as const, agentId: 'billing', reason: 'billing question' };
    };

    const driver: ChannelDriver = {
      async runAgentTurn() {
        agentTurns += 1;
        return {
          text: agentTurns === 1 ? '' : 'billing help here',
          toolResults: [],
        };
      },
      async awaitUser() {
        return { type: 'message', input: 'more' };
      },
    };

    const runtime = createRuntime({
      agents: [support, billing],
      defaultAgentId: 'support',
      sessionStore: new MemoryStore(),
      defaultModel: stubModel,
      maxHandoffs: 2,
      hostSelect,
    });

    const parts = await collectEvents(
      runtime.run({
        sessionId: 'triage-session',
        input: 'I have a billing question about invoice 42',
        driver,
      }),
    );

    expect(
      parts.some(
        (p) =>
          p.type === 'handoff' &&
          p.payload.targetAgent === 'billing' &&
          p.payload.reason === 'billing question',
      ),
    ).toBe(true);
    expect(calls).toBe(1);

    const followUp = runtime.run({
      sessionId: 'triage-session',
      input: 'Can you check invoice 42?',
      driver,
    });
    const result = await followUp;
    expect(result.text.toLowerCase()).toContain('billing');
    expect(calls).toBe(1);
  });
});
