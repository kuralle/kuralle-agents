import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import {
  collect,
  decide,
  defineAgent,
  defineFlow,
  reply,
  createRuntime,
  MemoryStore,
} from '@kuralle-agents/core';
import type { HarnessStreamPart, ChannelDriver } from '@kuralle-agents/core';

const stubModel = {} as LanguageModel;
import { OutboundPipeline, windowGuard, defaultInboundChain } from '@kuralle-agents/messaging';
import type { InboundMessage, OutboundRequest, OutboundSink } from '@kuralle-agents/messaging';
import { interactiveRenderer, withChoices } from '../src/index.js';

const openWindow = { open: true, expiresAt: new Date('2099-01-01') };

const threeChoices = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
] as const;

const driverWithStructured: ChannelDriver = {
  async runAgentTurn() {
    return { text: '', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: 'a' };
  },
  async runStructured() {
    return { choice: 'a' };
  },
};

function recordingSink(): OutboundSink & {
  interactiveCalls: Array<{ threadId: string; buttonCount: number }>;
} {
  const interactiveCalls: Array<{ threadId: string; buttonCount: number }> = [];
  return {
    interactiveCalls,
    sendText: async (to) => ({ messageId: 't', threadId: to, timestamp: new Date() }),
    sendInteractive: async (to, msg) => {
      const buttonCount =
        msg.action.type === 'buttons' ? msg.action.buttons.length : 0;
      interactiveCalls.push({ threadId: to, buttonCount });
      return { messageId: 'i', threadId: to, timestamp: new Date() };
    },
    sendMedia: async (to) => ({ messageId: 'm', threadId: to, timestamp: new Date() }),
  };
}

function inboundButton(id: string, title: string): InboundMessage {
  return {
    id: 'm-1',
    platform: 'whatsapp',
    threadId: '+1',
    customerId: 'u-1',
    from: { id: 'u-1' },
    timestamp: new Date(),
    type: 'interactive',
    interactive: { type: 'button_reply', id, title },
  };
}

describe('withchoices_attaches', () => {
  it('attaches choices to decide while preserving kind', () => {
    const base = decide({
      id: 'pick',
      instructions: 'Choose',
      schema: z.object({ choice: z.string() }),
      decide: () => reply({ id: 'end', instructions: 'Done', next: () => ({ end: 'done' }) }),
    });
    const node = withChoices(base, [{ id: 'a', label: 'A' }]);
    expect(node.kind).toBe('decide');
    expect(node.choices).toEqual([{ id: 'a', label: 'A' }]);
    expect(node.id).toBe('pick');
  });

  it('attaches choices to collect while preserving kind', () => {
    const base = collect({
      id: 'ask',
      schema: z.object({ name: z.string() }),
      onComplete: () => ({ end: 'done' }),
    });
    const node = withChoices(base, [{ id: 'yes', label: 'Yes' }]);
    expect(node.kind).toBe('collect');
    expect(node.choices).toEqual([{ id: 'yes', label: 'Yes' }]);
  });
});

describe('interactive_end_to_end', () => {
  it('emit → render (3 buttons) → resolve by id → formData', async () => {
    const endNode = reply({ id: 'end', instructions: 'Done', next: () => ({ end: 'done' }) });
    const decideNode = withChoices(
      decide({
        id: 'pick',
        instructions: 'Pick one',
        schema: z.object({ choice: z.string() }),
        decide: () => endNode,
      }),
      [...threeChoices],
    );

    const flow = defineFlow({
      name: 'interactive-e2e',
      description: 'S3-04 composed seams',
      start: decideNode,
      nodes: [decideNode, endNode],
    });

    const agent = defineAgent({ id: 'e2e', flows: [flow], model: stubModel });
    const sessionStore = new MemoryStore();
    const hostSelect = async () => ({
      kind: 'enterFlow' as const,
      flow,
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'e2e',
      sessionStore,
      defaultModel: stubModel,
      hostSelect,
    });

    const parts: HarnessStreamPart[] = [];
    const handle = runtime.run({
      sessionId: 's3-04-e2e',
      input: 'start',
      driver: driverWithStructured,
    });
    for await (const part of handle.events) {
      parts.push(part);
    }
    await handle;

    const interactiveParts = parts.filter((p) => p.type === 'interactive');
    expect(interactiveParts.length).toBeGreaterThanOrEqual(1);
    const emitted = interactiveParts[0]!;
    expect(emitted).toMatchObject({
      type: 'interactive',
      nodeId: 'pick',
      prompt: 'Pick one',
      options: threeChoices,
    });

    const sink = recordingSink();
    const pipeline = new OutboundPipeline([interactiveRenderer(), windowGuard], sink);
    const req: OutboundRequest = {
      threadId: 'thread-e2e',
      platform: 'whatsapp',
      payload: { kind: 'text', text: 'placeholder' },
      meta: {
        window: openWindow,
        parts: [emitted],
        sessionId: 's3-04-e2e',
      },
    };
    const outcome = await pipeline.send(req);
    expect(outcome.kind).toBe('sent');
    expect(sink.interactiveCalls).toHaveLength(1);
    expect(sink.interactiveCalls[0]!.buttonCount).toBe(3);

    const chain = defaultInboundChain();
    const byLabelA = await chain.resolve(inboundButton('a', 'Alpha'));
    const byLabelOther = await chain.resolve(inboundButton('a', 'not the display label'));
    expect(byLabelA).toEqual({ input: 'a', selection: { id: 'a' } });
    expect(byLabelOther).toEqual({ input: 'a', selection: { id: 'a' } });

    const formData = { plan: 'pro', seats: 2 };
    const flowSubmit = await chain.resolve({
      ...inboundButton('', ''),
      interactive: { type: 'nfm_reply', id: '', formResponse: formData },
    });
    expect(flowSubmit).toEqual({
      input: '__flow__',
      selection: { formData },
    });
  });
});
